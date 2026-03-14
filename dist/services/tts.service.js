"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.generateTTS = generateTTS;
const child_process_1 = require("child_process");
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const crypto_1 = __importDefault(require("crypto"));
const PIPER_BIN = "/opt/schoollive/piper/piper";
const MODELS_DIR = "/opt/schoollive/piper/models";
const AUDIO_DIR = "/opt/schoollive/backend/audio";
const DINGDONG = path_1.default.join(AUDIO_DIR, "dingdong.mp3");
const VOICES = {
    anna: "hu_HU-anna-medium.onnx",
    berta: "hu_HU-berta-medium.onnx",
    imre: "hu_HU-imre-medium.onnx",
};
// Futtat egy külső folyamatot és visszaadja a stderr-t ha hiba van
function runProcess(bin, args, input) {
    return new Promise((resolve, reject) => {
        const proc = (0, child_process_1.spawn)(bin, args);
        if (input !== undefined) {
            proc.stdin.write(input);
            proc.stdin.end();
        }
        let stderr = "";
        proc.stderr.on("data", (d) => { stderr += d.toString(); });
        proc.on("close", (code) => {
            if (code !== 0)
                return reject(new Error(`${path_1.default.basename(bin)} error (${code}): ${stderr.slice(-400)}`));
            resolve();
        });
        proc.on("error", (err) => reject(new Error(`${path_1.default.basename(bin)} spawn error: ${err.message}`)));
    });
}
async function generateTTS(text, voice = "anna") {
    const modelFile = VOICES[voice] ?? VOICES["anna"];
    const modelPath = path_1.default.join(MODELS_DIR, modelFile);
    const hasDingdong = fs_1.default.existsSync(DINGDONG);
    // Cache kulcsba belekerül a dingdong jelenléte,
    // hogy ne keveredjenek a régi (dingdong nélküli) fájlok az újakkal
    const cacheKey = `${text}|${voice}|dd:${hasDingdong ? "1" : "0"}`;
    const hash = crypto_1.default.createHash("sha256").update(cacheKey).digest("hex").slice(0, 16);
    const filename = `tts_${hash}.mp3`;
    const outPath = path_1.default.join(AUDIO_DIR, filename);
    // Cache találat
    if (fs_1.default.existsSync(outPath))
        return filename;
    const wavPath = path_1.default.join(AUDIO_DIR, `tts_${hash}_speech.wav`);
    const speechMp3 = path_1.default.join(AUDIO_DIR, `tts_${hash}_speech.mp3`);
    const concatList = path_1.default.join(AUDIO_DIR, `tts_${hash}_list.txt`);
    try {
        // ── 1. Piper: szöveg → WAV ─────────────────────────────────────────────
        await runProcess(PIPER_BIN, [
            "--model", modelPath,
            "--output_file", wavPath,
        ], text);
        if (!fs_1.default.existsSync(wavPath))
            throw new Error("Piper: WAV not created");
        // ── 2. WAV → MP3, loudnorm + kompresszió ──────────────────────────────
        // loudnorm: EBU R128 normalizálás (I=-14 LUFS, maximálisan hangos)
        // acompressor: dinamika szűkítése, hogy a halk részek is jól hallhatók legyenek
        await runProcess("ffmpeg", [
            "-y",
            "-i", wavPath,
            "-af", [
                "acompressor=threshold=-20dB:ratio=4:attack=5:release=50:makeup=6dB",
                "loudnorm=I=-14:TP=-1:LRA=7",
            ].join(","),
            "-codec:a", "libmp3lame",
            "-qscale:a", "2", // ~190kbps VBR – jó minőség
            speechMp3,
        ]);
        if (!fs_1.default.existsSync(speechMp3))
            throw new Error("ffmpeg: speech MP3 not created");
        // ── 3. Dingdong + TTS összefűzés ──────────────────────────────────────
        if (hasDingdong) {
            // ffmpeg concat demuxer: listafájl alapján fűzi össze
            fs_1.default.writeFileSync(concatList, `file '${DINGDONG}'\nfile '${speechMp3}'\n`);
            await runProcess("ffmpeg", [
                "-y",
                "-f", "concat",
                "-safe", "0",
                "-i", concatList,
                "-codec:a", "libmp3lame",
                "-qscale:a", "2",
                outPath,
            ]);
        }
        else {
            // Nincs dingdong – egyszerűen átnevezzük
            console.warn("[TTS] dingdong.mp3 not found at", DINGDONG, "– skipping prepend");
            fs_1.default.renameSync(speechMp3, outPath);
        }
        if (!fs_1.default.existsSync(outPath))
            throw new Error("ffmpeg: final MP3 not created");
        return filename;
    }
    finally {
        // Ideiglenes fájlok törlése
        for (const f of [wavPath, speechMp3, concatList]) {
            try {
                if (fs_1.default.existsSync(f))
                    fs_1.default.unlinkSync(f);
            }
            catch { }
        }
    }
}

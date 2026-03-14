"use strict";
// src/modules/radio/radio.routes.ts
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const child_process_1 = require("child_process");
const client_1 = require("../../prisma/client");
const authJwt_1 = require("../../middleware/authJwt");
const tenant_1 = require("../../middleware/tenant");
const multer_1 = __importDefault(require("multer"));
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const crypto_1 = __importDefault(require("crypto"));
const mm = __importStar(require("music-metadata"));
const router = (0, express_1.Router)();
// ─── Upload könyvtár ───────────────────────────────────────────────────────
const RADIO_UPLOAD_DIR = path_1.default.join(process.cwd(), "uploads", "radio");
if (!fs_1.default.existsSync(RADIO_UPLOAD_DIR)) {
    fs_1.default.mkdirSync(RADIO_UPLOAD_DIR, { recursive: true });
}
// ─── Multer konfig ─────────────────────────────────────────────────────────
const storage = multer_1.default.diskStorage({
    destination: (_req, _file, cb) => cb(null, RADIO_UPLOAD_DIR),
    filename: (_req, file, cb) => {
        const ext = path_1.default.extname(file.originalname).toLowerCase() || ".mp3";
        const hash = crypto_1.default.randomBytes(12).toString("hex");
        cb(null, `radio_${hash}${ext}`);
    },
});
const upload = (0, multer_1.default)({
    storage,
    limits: { fileSize: 200 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
        const allowed = [".mp3", ".wav", ".ogg", ".m4a", ".aac"];
        const ext = path_1.default.extname(file.originalname).toLowerCase();
        if (allowed.includes(ext) || file.mimetype.startsWith("audio/")) {
            cb(null, true);
        }
        else {
            cb(new Error("Only audio files are allowed"));
        }
    },
});
// ─── Segédfüggvények ───────────────────────────────────────────────────────
function tid(req) {
    return req.tenantId;
}
function uid(req) {
    return req.user?.sub;
}
function role(req) {
    return req.user?.role ?? "";
}
function canWrite(r) {
    return ["SUPER_ADMIN", "TENANT_ADMIN", "ORG_ADMIN"].includes(r);
}
function baseUrl() {
    return process.env.BASE_URL ?? "https://api.schoollive.hu";
}
function paramId(req) {
    return String(req.params.id);
}
async function getAudioDurationSec(filePath) {
    try {
        const meta = await mm.parseFile(filePath, { duration: true });
        const dur = meta.format.duration;
        return typeof dur === "number" && isFinite(dur) ? Math.round(dur) : null;
    }
    catch {
        return null;
    }
}
// ═══════════════════════════════════════════════════════════════════════════
// FÁJLKEZELÉS
// ═══════════════════════════════════════════════════════════════════════════
// GET /radio/files
router.get("/files", authJwt_1.authJwt, tenant_1.requireTenant, async (req, res) => {
    try {
        if (!canWrite(role(req)))
            return res.status(403).json({ error: "Forbidden" });
        const files = await client_1.prisma.radioFile.findMany({
            where: { tenantId: tid(req) },
            orderBy: { createdAt: "desc" },
            include: {
                createdBy: { select: { id: true, displayName: true, email: true } },
                schedules: { select: { id: true } },
            },
        });
        const result = files.map(f => ({
            ...f,
            _count: { schedules: f.schedules.length },
            schedules: undefined,
        }));
        return res.json({ ok: true, files: result });
    }
    catch (err) {
        console.error(err);
        return res.status(500).json({ error: "Failed to fetch radio files" });
    }
});
// POST /radio/files  (multipart upload)
router.post("/files", authJwt_1.authJwt, tenant_1.requireTenant, upload.single("file"), async (req, res) => {
    try {
        if (!canWrite(role(req))) {
            if (req.file)
                fs_1.default.unlinkSync(req.file.path);
            return res.status(403).json({ error: "Forbidden" });
        }
        if (!req.file)
            return res.status(400).json({ error: "No file uploaded" });
        const durationSec = await getAudioDurationSec(req.file.path);
        const fileUrl = `${baseUrl()}/uploads/radio/${req.file.filename}`;
        const radioFile = await client_1.prisma.radioFile.create({
            data: {
                tenantId: tid(req),
                createdById: uid(req),
                filename: req.file.filename,
                originalName: req.file.originalname,
                sizeBytes: req.file.size,
                durationSec,
                fileUrl,
            },
            include: {
                createdBy: { select: { id: true, displayName: true, email: true } },
            },
        });
        return res.status(201).json({ ok: true, file: { ...radioFile, _count: { schedules: 0 } } });
    }
    catch (err) {
        if (req.file) {
            try {
                fs_1.default.unlinkSync(req.file.path);
            }
            catch { }
        }
        if (err?.code === "P2002")
            return res.status(409).json({ error: "File already exists" });
        console.error(err);
        return res.status(500).json({ error: "Upload failed" });
    }
});
// DELETE /radio/files/:id
router.delete("/files/:id", authJwt_1.authJwt, tenant_1.requireTenant, async (req, res) => {
    try {
        if (!canWrite(role(req)))
            return res.status(403).json({ error: "Forbidden" });
        const id = paramId(req);
        const file = await client_1.prisma.radioFile.findFirst({ where: { id, tenantId: tid(req) } });
        if (!file)
            return res.status(404).json({ error: "File not found" });
        const schedCount = await client_1.prisma.radioSchedule.count({ where: { radioFileId: id } });
        const filePath = path_1.default.join(RADIO_UPLOAD_DIR, file.filename);
        if (fs_1.default.existsSync(filePath)) {
            try {
                fs_1.default.unlinkSync(filePath);
            }
            catch (e) {
                console.warn("[RADIO] Could not delete physical file:", e);
            }
        }
        await client_1.prisma.radioFile.delete({ where: { id: file.id } });
        return res.json({ ok: true, deletedSchedules: schedCount });
    }
    catch (err) {
        console.error(err);
        return res.status(500).json({ error: "Failed to delete file" });
    }
});
// ═══════════════════════════════════════════════════════════════════════════
// ÜTEMEZÉSEK
// ═══════════════════════════════════════════════════════════════════════════
// GET /radio/schedules
router.get("/schedules", authJwt_1.authJwt, tenant_1.requireTenant, async (req, res) => {
    try {
        if (!canWrite(role(req)))
            return res.status(403).json({ error: "Forbidden" });
        const from = req.query.from ? new Date(req.query.from) : undefined;
        const to = req.query.to ? new Date(req.query.to) : undefined;
        const schedules = await client_1.prisma.radioSchedule.findMany({
            where: {
                tenantId: tid(req),
                ...(from || to ? {
                    scheduledAt: {
                        ...(from ? { gte: from } : {}),
                        ...(to ? { lte: to } : {}),
                    },
                } : {}),
            },
            orderBy: { scheduledAt: "asc" },
            include: {
                radioFile: {
                    select: { id: true, originalName: true, filename: true, durationSec: true, fileUrl: true, sizeBytes: true },
                },
                createdBy: { select: { id: true, displayName: true, email: true } },
            },
        });
        return res.json({ ok: true, schedules });
    }
    catch (err) {
        console.error(err);
        return res.status(500).json({ error: "Failed to fetch schedules" });
    }
});
// POST /radio/schedules
router.post("/schedules", authJwt_1.authJwt, tenant_1.requireTenant, async (req, res) => {
    try {
        if (!canWrite(role(req)))
            return res.status(403).json({ error: "Forbidden" });
        const { radioFileId, targetType, targetId, scheduledAt } = req.body ?? {};
        if (!radioFileId || !targetType || !scheduledAt) {
            return res.status(400).json({ error: "radioFileId, targetType and scheduledAt are required" });
        }
        const scheduledDate = new Date(scheduledAt);
        if (isNaN(scheduledDate.getTime()))
            return res.status(400).json({ error: "Invalid scheduledAt date" });
        if (scheduledDate < new Date())
            return res.status(400).json({ error: "scheduledAt must be in the future" });
        const file = await client_1.prisma.radioFile.findFirst({
            where: { id: String(radioFileId), tenantId: tid(req) },
            select: { id: true, durationSec: true },
        });
        if (!file)
            return res.status(404).json({ error: "Radio file not found" });
        // Ütközésdetekció
        if (file.durationSec) {
            const endTime = new Date(scheduledDate.getTime() + file.durationSec * 1000);
            const conflict = await client_1.prisma.radioSchedule.findFirst({
                where: {
                    tenantId: tid(req),
                    status: "PENDING",
                    targetType: targetType,
                    ...(targetId ? { targetId: String(targetId) } : {}),
                    scheduledAt: { lt: endTime },
                },
                include: { radioFile: { select: { durationSec: true, originalName: true } } },
            });
            if (conflict) {
                const conflictEnd = conflict.radioFile.durationSec
                    ? new Date(conflict.scheduledAt.getTime() + conflict.radioFile.durationSec * 1000)
                    : null;
                if (!conflictEnd || conflictEnd > scheduledDate) {
                    return res.status(409).json({
                        error: "Időütközés",
                        conflict: {
                            id: conflict.id,
                            scheduledAt: conflict.scheduledAt,
                            originalName: conflict.radioFile.originalName,
                        },
                    });
                }
            }
        }
        const schedule = await client_1.prisma.radioSchedule.create({
            data: {
                tenantId: tid(req),
                createdById: uid(req),
                radioFileId: file.id,
                targetType: targetType,
                targetId: targetId ? String(targetId) : null,
                scheduledAt: scheduledDate,
                status: "PENDING",
            },
            include: {
                radioFile: { select: { id: true, originalName: true, durationSec: true, fileUrl: true } },
            },
        });
        return res.status(201).json({ ok: true, schedule });
    }
    catch (err) {
        console.error(err);
        return res.status(500).json({ error: "Failed to create schedule" });
    }
});
// PATCH /radio/schedules/:id
router.patch("/schedules/:id", authJwt_1.authJwt, tenant_1.requireTenant, async (req, res) => {
    try {
        if (!canWrite(role(req)))
            return res.status(403).json({ error: "Forbidden" });
        const id = paramId(req);
        const existing = await client_1.prisma.radioSchedule.findFirst({ where: { id, tenantId: tid(req) } });
        if (!existing)
            return res.status(404).json({ error: "Schedule not found" });
        if (existing.status !== "PENDING")
            return res.status(400).json({ error: "Only PENDING schedules can be modified" });
        const { scheduledAt, targetType, targetId } = req.body ?? {};
        const data = {};
        if (scheduledAt) {
            const d = new Date(scheduledAt);
            if (isNaN(d.getTime()))
                return res.status(400).json({ error: "Invalid scheduledAt" });
            if (d < new Date())
                return res.status(400).json({ error: "scheduledAt must be in the future" });
            data.scheduledAt = d;
        }
        if (targetType)
            data.targetType = targetType;
        if (typeof targetId !== "undefined")
            data.targetId = targetId ?? null;
        if (Object.keys(data).length === 0)
            return res.status(400).json({ error: "No changes provided" });
        const updated = await client_1.prisma.radioSchedule.update({
            where: { id: existing.id },
            data,
            include: {
                radioFile: { select: { id: true, originalName: true, durationSec: true, fileUrl: true } },
            },
        });
        return res.json({ ok: true, schedule: updated });
    }
    catch (err) {
        console.error(err);
        return res.status(500).json({ error: "Failed to update schedule" });
    }
});
// DELETE /radio/schedules/:id
router.delete("/schedules/:id", authJwt_1.authJwt, tenant_1.requireTenant, async (req, res) => {
    try {
        if (!canWrite(role(req)))
            return res.status(403).json({ error: "Forbidden" });
        const id = paramId(req);
        const existing = await client_1.prisma.radioSchedule.findFirst({ where: { id, tenantId: tid(req) } });
        if (!existing)
            return res.status(404).json({ error: "Schedule not found" });
        await client_1.prisma.radioSchedule.delete({ where: { id: existing.id } });
        return res.json({ ok: true });
    }
    catch (err) {
        console.error(err);
        return res.status(500).json({ error: "Failed to delete schedule" });
    }
});
// ═══════════════════════════════════════════════════════════════════════════
// ESZKÖZÖK ÉS CSOPORTOK (célválasztóhoz)
// ═══════════════════════════════════════════════════════════════════════════
router.get("/targets", authJwt_1.authJwt, tenant_1.requireTenant, async (req, res) => {
    try {
        if (!canWrite(role(req)))
            return res.status(403).json({ error: "Forbidden" });
        const [devices, groups] = await Promise.all([
            client_1.prisma.device.findMany({
                where: { tenantId: tid(req) },
                select: { id: true, name: true, online: true, deviceClass: true },
                orderBy: { name: "asc" },
            }),
            client_1.prisma.deviceGroup.findMany({
                where: { tenantId: tid(req) },
                select: { id: true, name: true },
                orderBy: { name: "asc" },
            }),
        ]);
        return res.json({ ok: true, devices, groups });
    }
    catch (err) {
        console.error(err);
        return res.status(500).json({ error: "Failed to fetch targets" });
    }
});
exports.default = router;
// ═══════════════════════════════════════════════════════════════════════════
// YOUTUBE LEJÁTSZÁSI LISTÁK
// ═══════════════════════════════════════════════════════════════════════════
const YT_DLP_BIN = process.env.YT_DLP_BIN ?? "yt-dlp";
function runCmd(bin, args) {
    return new Promise((resolve, reject) => {
        const proc = (0, child_process_1.spawn)(bin, args);
        let out = "";
        let err = "";
        proc.stdout.on("data", (d) => { out += d.toString(); });
        proc.stderr.on("data", (d) => { err += d.toString(); });
        proc.on("close", (code) => {
            if (code !== 0)
                return reject(new Error(`${bin} exited ${code}: ${err.slice(-300)}`));
            resolve(out.trim());
        });
        proc.on("error", (e) => reject(new Error(`spawn error: ${e.message}`)));
    });
}
// Validálás: YouTube URL-e?
function isYoutubeUrl(url) {
    return /^https?:\/\/(www\.)?(youtube\.com\/(watch|shorts)|youtu\.be\/)/.test(url.trim());
}
// GET /radio/ytplaylists
router.get("/ytplaylists", authJwt_1.authJwt, tenant_1.requireTenant, async (req, res) => {
    try {
        const playlists = await client_1.prisma.youtubePlaylist.findMany({
            where: { tenantId: tid(req) },
            include: { items: { orderBy: { sortOrder: "asc" } } },
            orderBy: { createdAt: "desc" },
        });
        return res.json({ ok: true, playlists });
    }
    catch (err) {
        console.error(err);
        return res.status(500).json({ error: "Failed to fetch playlists" });
    }
});
// POST /radio/ytplaylists
router.post("/ytplaylists", authJwt_1.authJwt, tenant_1.requireTenant, async (req, res) => {
    try {
        if (!canWrite(role(req)))
            return res.status(403).json({ error: "Forbidden" });
        const { name, items } = req.body;
        if (!name?.trim())
            return res.status(400).json({ error: "name is required" });
        if (!Array.isArray(items) || items.length === 0)
            return res.status(400).json({ error: "items array required" });
        for (const item of items) {
            if (!isYoutubeUrl(item.youtubeUrl)) {
                return res.status(400).json({ error: `Érvénytelen YouTube URL: ${item.youtubeUrl}` });
            }
        }
        const playlist = await client_1.prisma.youtubePlaylist.create({
            data: {
                tenantId: tid(req),
                name: name.trim(),
                createdById: uid(req),
                items: {
                    create: items.map((item, i) => ({
                        youtubeUrl: item.youtubeUrl.trim(),
                        title: item.title?.trim() ?? null,
                        sortOrder: i,
                    })),
                },
            },
            include: { items: { orderBy: { sortOrder: "asc" } } },
        });
        return res.status(201).json({ ok: true, playlist });
    }
    catch (err) {
        console.error(err);
        return res.status(500).json({ error: "Failed to create playlist" });
    }
});
// PATCH /radio/ytplaylists/:id
router.patch("/ytplaylists/:id", authJwt_1.authJwt, tenant_1.requireTenant, async (req, res) => {
    try {
        if (!canWrite(role(req)))
            return res.status(403).json({ error: "Forbidden" });
        const id = paramId(req);
        const existing = await client_1.prisma.youtubePlaylist.findFirst({ where: { id, tenantId: tid(req) } });
        if (!existing)
            return res.status(404).json({ error: "Not found" });
        if (existing.status === "BUILDING")
            return res.status(409).json({ error: "Build folyamatban – várd meg a végét" });
        const { name, items } = req.body;
        const data = { status: "IDLE", errorMsg: null, radioFileId: null, updatedAt: new Date() };
        if (name?.trim())
            data.name = name.trim();
        await client_1.prisma.youtubePlaylist.update({ where: { id }, data });
        if (Array.isArray(items)) {
            for (const item of items) {
                if (!isYoutubeUrl(item.youtubeUrl)) {
                    return res.status(400).json({ error: `Érvénytelen YouTube URL: ${item.youtubeUrl}` });
                }
            }
            await client_1.prisma.youtubePlaylistItem.deleteMany({ where: { playlistId: id } });
            await client_1.prisma.youtubePlaylistItem.createMany({
                data: items.map((item, i) => ({
                    playlistId: id,
                    youtubeUrl: item.youtubeUrl.trim(),
                    title: item.title?.trim() ?? null,
                    sortOrder: i,
                })),
            });
        }
        const updated = await client_1.prisma.youtubePlaylist.findFirst({
            where: { id },
            include: { items: { orderBy: { sortOrder: "asc" } } },
        });
        return res.json({ ok: true, playlist: updated });
    }
    catch (err) {
        console.error(err);
        return res.status(500).json({ error: "Failed to update playlist" });
    }
});
// DELETE /radio/ytplaylists/:id
router.delete("/ytplaylists/:id", authJwt_1.authJwt, tenant_1.requireTenant, async (req, res) => {
    try {
        if (!canWrite(role(req)))
            return res.status(403).json({ error: "Forbidden" });
        const id = paramId(req);
        const existing = await client_1.prisma.youtubePlaylist.findFirst({ where: { id, tenantId: tid(req) } });
        if (!existing)
            return res.status(404).json({ error: "Not found" });
        await client_1.prisma.youtubePlaylist.delete({ where: { id } });
        return res.json({ ok: true });
    }
    catch (err) {
        console.error(err);
        return res.status(500).json({ error: "Failed to delete playlist" });
    }
});
// POST /radio/ytplaylists/:id/build
// Aszinkron build – azonnal visszatér, háttérben fut
router.post("/ytplaylists/:id/build", authJwt_1.authJwt, tenant_1.requireTenant, async (req, res) => {
    try {
        if (!canWrite(role(req)))
            return res.status(403).json({ error: "Forbidden" });
        const id = paramId(req);
        const playlist = await client_1.prisma.youtubePlaylist.findFirst({
            where: { id, tenantId: tid(req) },
            include: { items: { orderBy: { sortOrder: "asc" } } },
        });
        if (!playlist)
            return res.status(404).json({ error: "Not found" });
        if (playlist.status === "BUILDING")
            return res.status(409).json({ error: "Már folyamatban van a build" });
        if (playlist.items.length === 0)
            return res.status(400).json({ error: "Nincs elem a listában" });
        // BUILDING státusz beállítása
        await client_1.prisma.youtubePlaylist.update({
            where: { id },
            data: { status: "BUILDING", errorMsg: null, updatedAt: new Date() },
        });
        // Aszinkron build indítása
        buildYoutubePlaylist(id, playlist, tid(req), uid(req)).catch(async (err) => {
            console.error(`[YT-BUILD] Fatal error for playlist ${id}:`, err);
            await client_1.prisma.youtubePlaylist.update({
                where: { id },
                data: { status: "ERROR", errorMsg: String(err?.message ?? err), updatedAt: new Date() },
            }).catch(() => { });
        });
        return res.json({ ok: true, status: "BUILDING" });
    }
    catch (err) {
        console.error(err);
        return res.status(500).json({ error: "Failed to start build" });
    }
});
// GET /radio/ytplaylists/:id/status
router.get("/ytplaylists/:id/status", authJwt_1.authJwt, tenant_1.requireTenant, async (req, res) => {
    try {
        const id = paramId(req);
        const playlist = await client_1.prisma.youtubePlaylist.findFirst({
            where: { id, tenantId: tid(req) },
            select: { id: true, status: true, errorMsg: true, radioFileId: true, updatedAt: true },
        });
        if (!playlist)
            return res.status(404).json({ error: "Not found" });
        return res.json({ ok: true, ...playlist });
    }
    catch (err) {
        console.error(err);
        return res.status(500).json({ error: "Failed to fetch status" });
    }
});
// ── Build folyamat ────────────────────────────────────────────────────────────
async function buildYoutubePlaylist(playlistId, playlist, tenantId, createdById) {
    const tmpDir = path_1.default.join(RADIO_UPLOAD_DIR, `yt_tmp_${playlistId}`);
    const concatFile = path_1.default.join(tmpDir, "concat.txt");
    fs_1.default.mkdirSync(tmpDir, { recursive: true });
    try {
        console.log(`[YT-BUILD] Starting build for playlist "${playlist.name}" (${playlist.items.length} items)`);
        const downloadedFiles = [];
        // ── 1. Minden URL letöltése yt-dlp-vel ──────────────────────────────────
        for (let i = 0; i < playlist.items.length; i++) {
            const item = playlist.items[i];
            const outTmpl = path_1.default.join(tmpDir, `track_${String(i).padStart(3, "0")}.%(ext)s`);
            console.log(`[YT-BUILD] [${i + 1}/${playlist.items.length}] Downloading: ${item.youtubeUrl}`);
            await runCmd(YT_DLP_BIN, [
                "--extract-audio",
                "--audio-format", "mp3",
                "--audio-quality", "128K",
                "--no-playlist",
                "--output", outTmpl,
                "--no-warnings",
                item.youtubeUrl,
            ]);
            // Megkeressük a letöltött fájlt
            const files = fs_1.default.readdirSync(tmpDir).filter(f => f.startsWith(`track_${String(i).padStart(3, "0")}`));
            if (files.length === 0)
                throw new Error(`yt-dlp: letöltés sikertelen: ${item.youtubeUrl}`);
            downloadedFiles.push(path_1.default.join(tmpDir, files[0]));
        }
        // ── 2. Concat fájl elkészítése ───────────────────────────────────────────
        const concatContent = downloadedFiles.map(f => `file '${f}'`).join("\n");
        fs_1.default.writeFileSync(concatFile, concatContent);
        // ── 3. ffmpeg: összefűzés 128kbps MP3-ba ────────────────────────────────
        const hash = crypto_1.default.randomBytes(12).toString("hex");
        const filename = `radio_yt_${hash}.mp3`;
        const outputPath = path_1.default.join(RADIO_UPLOAD_DIR, filename);
        await runCmd("ffmpeg", [
            "-y",
            "-f", "concat",
            "-safe", "0",
            "-i", concatFile,
            "-codec:a", "libmp3lame",
            "-b:a", "128k",
            "-id3v2_version", "3",
            outputPath,
        ]);
        if (!fs_1.default.existsSync(outputPath))
            throw new Error("ffmpeg: kimeneti MP3 nem jött létre");
        const sizeBytes = fs_1.default.statSync(outputPath).size;
        const durationSec = await getAudioDurationSec(outputPath);
        const fileUrl = `${baseUrl()}/uploads/radio/${filename}`;
        // ── 4. RadioFile rekord létrehozása ─────────────────────────────────────
        const radioFile = await client_1.prisma.radioFile.create({
            data: {
                tenantId,
                filename,
                originalName: `${playlist.name}.mp3`,
                sizeBytes,
                durationSec,
                fileUrl,
                createdById,
            },
        });
        // ── 5. Playlist frissítése ───────────────────────────────────────────────
        await client_1.prisma.youtubePlaylist.update({
            where: { id: playlistId },
            data: { status: "DONE", radioFileId: radioFile.id, updatedAt: new Date() },
        });
        console.log(`[YT-BUILD] ✅ Done! RadioFile: ${filename} (${(sizeBytes / 1024 / 1024).toFixed(1)} MB, ${durationSec}s)`);
    }
    finally {
        // Ideiglenes könyvtár törlése
        try {
            fs_1.default.rmSync(tmpDir, { recursive: true, force: true });
        }
        catch { }
    }
}
// ═══════════════════════════════════════════════════════════════════════════
// VÉSZLEÁLLÍTÓ + NOW PLAYING
// ═══════════════════════════════════════════════════════════════════════════
// POST /radio/stop-all
// Minden VP eszközre (authType: JWT) STOP_PLAYBACK parancsot küld.
router.post("/stop-all", authJwt_1.authJwt, tenant_1.requireTenant, async (req, res) => {
    try {
        if (!canWrite(role(req)))
            return res.status(403).json({ error: "Forbidden" });
        const vpDevices = await client_1.prisma.device.findMany({
            where: { tenantId: tid(req), authType: "JWT" },
            select: { id: true },
        });
        if (vpDevices.length === 0) {
            return res.json({ ok: true, sent: 0 });
        }
        await client_1.prisma.deviceCommand.createMany({
            data: vpDevices.map(d => ({
                tenantId: tid(req),
                deviceId: d.id,
                status: "QUEUED",
                payload: { action: "STOP_PLAYBACK" },
            })),
        });
        console.log(`[RADIO] STOP_PLAYBACK sent to ${vpDevices.length} VP device(s)`);
        return res.json({ ok: true, sent: vpDevices.length });
    }
    catch (err) {
        console.error(err);
        return res.status(500).json({ error: "Failed to stop playback" });
    }
});
// GET /radio/now-playing
// Visszaadja az összes VP eszköz utolsó SENT/ACKED PLAY_URL/TTS parancsát
// (azaz amit éppen játszanak – heurisztika: legutóbbi dispatched command).
router.get("/now-playing", authJwt_1.authJwt, tenant_1.requireTenant, async (req, res) => {
    try {
        const vpDevices = await client_1.prisma.device.findMany({
            where: { tenantId: tid(req), authType: "JWT" },
            select: { id: true, name: true, online: true, lastSeenAt: true },
        });
        if (vpDevices.length === 0) {
            return res.json({ ok: true, nowPlaying: null, devices: [] });
        }
        const deviceIds = vpDevices.map(d => d.id);
        // Legutóbbi PLAY_URL vagy TTS parancs (SENT vagy ACKED), ami az utóbbi 6 órában volt
        const since = new Date(Date.now() - 6 * 60 * 60 * 1000);
        const cmd = await client_1.prisma.deviceCommand.findFirst({
            where: {
                deviceId: { in: deviceIds },
                status: { in: ["SENT", "ACKED"] },
                queuedAt: { gte: since },
                payload: { path: ["action"], array_contains: undefined },
            },
            orderBy: { queuedAt: "desc" },
        });
        // Payload action szűrés JS-ben (JSON path query nem mindenhol megbízható)
        let nowPlaying = null;
        if (cmd) {
            const payload = cmd.payload;
            if (payload?.action === "PLAY_URL" || payload?.action === "TTS") {
                // Megkeressük a RadioFile-t ha van messageId vagy payload.url alapján
                let name = payload?.title ?? payload?.url?.split("/").pop() ?? "Ismeretlen";
                let durationSec = null;
                if (cmd.messageId) {
                    const msg = await client_1.prisma.message.findUnique({
                        where: { id: cmd.messageId },
                        select: { title: true },
                    });
                    if (msg?.title)
                        name = msg.title;
                }
                else if (payload?.url) {
                    // URL-ből próbáljuk megtalálni a RadioFile-t
                    const filename = payload.url.split("/").pop()?.split("?")[0] ?? "";
                    if (filename) {
                        const rf = await client_1.prisma.radioFile.findFirst({
                            where: { tenantId: tid(req), filename },
                            select: { originalName: true, durationSec: true },
                        });
                        if (rf) {
                            name = rf.originalName;
                            durationSec = rf.durationSec;
                        }
                    }
                }
                nowPlaying = {
                    name,
                    durationSec,
                    queuedAt: cmd.queuedAt.toISOString(),
                };
            }
        }
        return res.json({ ok: true, nowPlaying });
    }
    catch (err) {
        console.error(err);
        return res.status(500).json({ error: "Failed to fetch now playing" });
    }
});
// ═══════════════════════════════════════════════════════════════════════════
// PLAYLIST BUILDER – ÚJ ENDPOINTOK
// ═══════════════════════════════════════════════════════════════════════════
// In-memory build állapot tracker (fileId → status)
const buildStatusMap = new Map();
// ── GET /radio/yt-info?url=... ────────────────────────────────────────────
// YouTube videó cím + hossz lekérése yt-dlp-vel
router.get("/yt-info", authJwt_1.authJwt, tenant_1.requireTenant, async (req, res) => {
    const url = String(req.query.url ?? "").trim();
    if (!url)
        return res.status(400).json({ ok: false, error: "url required" });
    try {
        const out = await runCmd(YT_DLP_BIN, [
            "--print", "%(title)s|||%(duration)s",
            "--no-playlist",
            "--no-warnings",
            "--skip-download",
            url,
        ]);
        const [title, durationRaw] = out.split("|||");
        const durationSec = Math.round(parseFloat(durationRaw));
        if (!title || isNaN(durationSec))
            return res.status(422).json({ ok: false, error: "Nem sikerült kiolvasni az adatokat" });
        return res.json({ ok: true, title: title.trim(), durationSec });
    }
    catch (err) {
        console.error("[yt-info]", err?.message);
        return res.status(422).json({ ok: false, error: "Nem sikerült betölteni a videó adatait" });
    }
});
// ── GET /radio/yt-search?q=...&limit=5 ───────────────────────────────────
// YouTube keresés yt-dlp-vel
router.get("/yt-search", authJwt_1.authJwt, tenant_1.requireTenant, async (req, res) => {
    const q = String(req.query.q ?? "").trim();
    const limit = Math.min(10, Math.max(1, parseInt(String(req.query.limit ?? "5"), 10) || 5));
    if (!q)
        return res.status(400).json({ ok: false, error: "q required" });
    try {
        const out = await runCmd(YT_DLP_BIN, [
            `ytsearch${limit}:${q}`,
            "--print", "%(id)s|||%(title)s|||%(duration_string)s|||%(thumbnail)s",
            "--flat-playlist",
            "--no-warnings",
            "--skip-download",
        ]);
        const results = out.split("\n")
            .map(line => line.trim())
            .filter(Boolean)
            .map(line => {
            const [id, title, duration, thumbnail] = line.split("|||");
            return { id: id?.trim(), title: title?.trim(), duration: duration?.trim() ?? "?:??", thumbnail: thumbnail?.trim() ?? "" };
        })
            .filter(r => r.id && r.title);
        return res.json({ ok: true, results });
    }
    catch (err) {
        console.error("[yt-search]", err?.message);
        return res.json({ ok: true, results: [] });
    }
});
// ── GET /radio/gdrive-files?url=... ──────────────────────────────────────
// Google Drive fájl vagy mappa hangfájljainak listázása
router.get("/gdrive-files", authJwt_1.authJwt, tenant_1.requireTenant, async (req, res) => {
    const url = String(req.query.url ?? "").trim();
    if (!url)
        return res.status(400).json({ ok: false, error: "url required" });
    // Mappa (folders/ID) vagy fájl (file/d/ID)?
    const isFolderUrl = /\/drive\/folders\//.test(url);
    try {
        if (isFolderUrl) {
            // Mappa: flat playlist listing
            const out = await runCmd(YT_DLP_BIN, [
                url,
                "--flat-playlist",
                "--print", "%(title)s|||%(url)s|||%(duration)s",
                "--no-warnings",
                "--skip-download",
            ]);
            const files = out.split("\n")
                .map(l => l.trim()).filter(Boolean)
                .map(line => {
                const [name, fileUrl, durRaw] = line.split("|||");
                const durationSec = durRaw ? Math.round(parseFloat(durRaw)) || null : null;
                return { name: name?.trim() ?? "Ismeretlen", url: fileUrl?.trim() ?? "", durationSec };
            })
                .filter(f => f.url && /\.(mp3|wav|ogg|m4a|aac|flac)/i.test(f.name));
            return res.json({ ok: true, files });
        }
        else {
            // Egyedi fájl
            const out = await runCmd(YT_DLP_BIN, [
                url,
                "--print", "%(title)s|||%(url)s|||%(duration)s",
                "--no-warnings",
                "--skip-download",
            ]);
            const [name, fileUrl, durRaw] = out.trim().split("|||");
            const durationSec = durRaw ? Math.round(parseFloat(durRaw)) || null : null;
            return res.json({ ok: true, files: [{ name: name?.trim() ?? "Hangfájl", url: fileUrl?.trim() ?? url, durationSec }] });
        }
    }
    catch (err) {
        console.error("[gdrive-files]", err?.message);
        return res.status(422).json({ ok: false, error: "Nem sikerült betölteni a Drive fájlokat. Győződj meg róla, hogy a link nyilvánosan megosztott." });
    }
});
// ── POST /radio/files/trim ────────────────────────────────────────────────
// Hangfájl levágása + fade-out, eredmény mentése "-edited" névvel
router.post("/files/trim", authJwt_1.authJwt, tenant_1.requireTenant, async (req, res) => {
    if (!canWrite(role(req)))
        return res.status(403).json({ error: "Forbidden" });
    const { fileId, trimSec, fadeOut = 5 } = req.body;
    if (!fileId || !trimSec)
        return res.status(400).json({ error: "fileId és trimSec kötelező" });
    try {
        const radioFile = await client_1.prisma.radioFile.findFirst({ where: { id: fileId, tenantId: tid(req) } });
        if (!radioFile)
            return res.status(404).json({ error: "Fájl nem található" });
        const inputPath = path_1.default.join(RADIO_UPLOAD_DIR, radioFile.filename);
        if (!fs_1.default.existsSync(inputPath))
            return res.status(404).json({ error: "Fájl nem található a szerveren" });
        const hash = crypto_1.default.randomBytes(12).toString("hex");
        const filename = `radio_${hash}_edited.mp3`;
        const outputPath = path_1.default.join(RADIO_UPLOAD_DIR, filename);
        const fadeStart = Math.max(0, trimSec - fadeOut);
        await runCmd("ffmpeg", [
            "-y",
            "-i", inputPath,
            "-t", String(trimSec),
            "-af", `afade=t=out:st=${fadeStart}:d=${fadeOut}`,
            "-codec:a", "libmp3lame",
            "-b:a", "128k",
            outputPath,
        ]);
        const sizeBytes = fs_1.default.statSync(outputPath).size;
        const durationSec = await getAudioDurationSec(outputPath);
        const fileUrl = `${baseUrl()}/uploads/radio/${filename}`;
        // Eredeti fájlnév alapú -edited név
        const baseName = radioFile.originalName.replace(/\.mp3$/i, "");
        const editedName = `${baseName}-edited.mp3`;
        const newFile = await client_1.prisma.radioFile.create({
            data: { tenantId: tid(req), createdById: uid(req), filename, originalName: editedName, sizeBytes, durationSec, fileUrl },
        });
        return res.json({ ok: true, fileId: newFile.id, filename: editedName, fileUrl, durationSec });
    }
    catch (err) {
        console.error("[trim]", err?.message);
        return res.status(500).json({ error: "Vágás sikertelen: " + (err?.message ?? "") });
    }
});
// ── POST /radio/ytplaylists/build-custom ─────────────────────────────────
// Egyedi lista összeállítása vegyes forrásokból (youtube, gdrive, upload)
router.post("/ytplaylists/build-custom", authJwt_1.authJwt, tenant_1.requireTenant, async (req, res) => {
    if (!canWrite(role(req)))
        return res.status(403).json({ error: "Forbidden" });
    const { name, items } = req.body;
    if (!name?.trim() || !items?.length)
        return res.status(400).json({ error: "name és items kötelező" });
    const buildId = crypto_1.default.randomBytes(12).toString("hex");
    buildStatusMap.set(buildId, { status: "BUILDING" });
    // Aszinkron build
    (async () => {
        const tmpDir = path_1.default.join(RADIO_UPLOAD_DIR, `custom_tmp_${buildId}`);
        fs_1.default.mkdirSync(tmpDir, { recursive: true });
        try {
            const downloadedFiles = [];
            const tenantId = tid(req);
            const createdById = uid(req);
            for (let i = 0; i < items.length; i++) {
                const item = items[i];
                const outBase = path_1.default.join(tmpDir, `track_${String(i).padStart(3, "0")}`);
                console.log(`[CUSTOM-BUILD] [${i + 1}/${items.length}] ${item.source}: ${item.title}`);
                if (item.source === "youtube") {
                    await runCmd(YT_DLP_BIN, [
                        "--extract-audio",
                        "--audio-format", "mp3",
                        "--audio-quality", "128K",
                        "--no-playlist",
                        "--output", `${outBase}.%(ext)s`,
                        "--no-warnings",
                        item.url,
                    ]);
                    const found = fs_1.default.readdirSync(tmpDir).find(f => f.startsWith(`track_${String(i).padStart(3, "0")}`));
                    if (!found)
                        throw new Error(`yt-dlp letöltés sikertelen: ${item.url}`);
                    downloadedFiles.push(path_1.default.join(tmpDir, found));
                }
                else if (item.source === "gdrive") {
                    await runCmd(YT_DLP_BIN, [
                        "--extract-audio",
                        "--audio-format", "mp3",
                        "--audio-quality", "128K",
                        "--output", `${outBase}.%(ext)s`,
                        "--no-warnings",
                        item.url,
                    ]);
                    const found = fs_1.default.readdirSync(tmpDir).find(f => f.startsWith(`track_${String(i).padStart(3, "0")}`));
                    if (!found)
                        throw new Error(`Drive letöltés sikertelen: ${item.url}`);
                    downloadedFiles.push(path_1.default.join(tmpDir, found));
                }
                else {
                    // upload: URL alapján letöltés vagy helyi fájl másolása
                    const localFilename = item.url.split("/").pop()?.split("?")[0];
                    const localPath = localFilename ? path_1.default.join(RADIO_UPLOAD_DIR, localFilename) : null;
                    if (localPath && fs_1.default.existsSync(localPath)) {
                        const dest = `${outBase}.mp3`;
                        fs_1.default.copyFileSync(localPath, dest);
                        downloadedFiles.push(dest);
                    }
                    else if (item.url.startsWith("http")) {
                        // Letöltés fetch-el
                        const https = await Promise.resolve().then(() => __importStar(require("https")));
                        const http = await Promise.resolve().then(() => __importStar(require("http")));
                        const dest = `${outBase}.mp3`;
                        await new Promise((resolve, reject) => {
                            const mod = item.url.startsWith("https") ? https.default : http.default;
                            const file = fs_1.default.createWriteStream(dest);
                            mod.get(item.url, resp => {
                                resp.pipe(file);
                                file.on("finish", () => { file.close(); resolve(); });
                            }).on("error", reject);
                        });
                        downloadedFiles.push(dest);
                    }
                    else {
                        throw new Error(`Ismeretlen forrás: ${item.url}`);
                    }
                }
            }
            // Concat
            const concatFile = path_1.default.join(tmpDir, "concat.txt");
            fs_1.default.writeFileSync(concatFile, downloadedFiles.map(f => `file '${f}'`).join("\n"));
            const hash = crypto_1.default.randomBytes(12).toString("hex");
            const filename = `radio_custom_${hash}.mp3`;
            const outputPath = path_1.default.join(RADIO_UPLOAD_DIR, filename);
            await runCmd("ffmpeg", [
                "-y", "-f", "concat", "-safe", "0", "-i", concatFile,
                "-codec:a", "libmp3lame", "-b:a", "128k",
                outputPath,
            ]);
            const sizeBytes = fs_1.default.statSync(outputPath).size;
            const durationSec = await getAudioDurationSec(outputPath);
            const fileUrl = `${baseUrl()}/uploads/radio/${filename}`;
            const radioFile = await client_1.prisma.radioFile.create({
                data: { tenantId, createdById, filename, originalName: `${name.trim()}.mp3`, sizeBytes, durationSec, fileUrl },
            });
            buildStatusMap.set(buildId, { status: "DONE", fileUrl, name: radioFile.originalName });
            // FileId-t is tároljuk
            buildStatusMap.set(`${buildId}_fileId`, { status: "DONE", fileUrl, name: radioFile.id });
            console.log(`[CUSTOM-BUILD] ✅ ${filename} (${(sizeBytes / 1024 / 1024).toFixed(1)} MB)`);
        }
        catch (err) {
            console.error("[CUSTOM-BUILD] Error:", err?.message);
            buildStatusMap.set(buildId, { status: "ERROR", errorMsg: err?.message });
        }
        finally {
            try {
                fs_1.default.rmSync(tmpDir, { recursive: true, force: true });
            }
            catch { }
        }
    })();
    return res.json({ ok: true, fileId: buildId });
});
// ── GET /radio/ytplaylists/build-status/:fileId ───────────────────────────
router.get("/ytplaylists/build-status/:fileId", authJwt_1.authJwt, tenant_1.requireTenant, async (req, res) => {
    const buildId = String(req.params.fileId);
    const status = buildStatusMap.get(buildId);
    if (!status)
        return res.status(404).json({ ok: false, error: "Nincs ilyen build" });
    // Ha DONE, a radioFileId-t a _fileId kulcson tároltuk
    let fileId;
    if (status.status === "DONE") {
        fileId = buildStatusMap.get(`${buildId}_fileId`)?.name;
    }
    return res.json({ ok: true, status: status.status, fileUrl: status.fileUrl, name: status.name, fileId, errorMsg: status.errorMsg });
});

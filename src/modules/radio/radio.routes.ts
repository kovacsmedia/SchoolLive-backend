// src/modules/radio/radio.routes.ts

import { Router, Request, Response } from "express";
import { spawn as _spawn } from "child_process";
import { prisma } from "../../prisma/client";
import { authJwt } from "../../middleware/authJwt";
import { requireTenant } from "../../middleware/tenant";
import multer from "multer";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import * as mm from "music-metadata";

const router = Router();

const RADIO_UPLOAD_DIR = path.join(process.cwd(), "uploads", "radio");
if (!fs.existsSync(RADIO_UPLOAD_DIR)) {
  fs.mkdirSync(RADIO_UPLOAD_DIR, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, RADIO_UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const ext  = path.extname(file.originalname).toLowerCase() || ".mp3";
    const hash = crypto.randomBytes(12).toString("hex");
    cb(null, `radio_${hash}${ext}`);
  },
});

function fixEncoding(name: string): string {
  try { return Buffer.from(name, "latin1").toString("utf8"); } catch { return name; }
}

const upload = multer({
  storage,
  limits: { fileSize: 200 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = [".mp3", ".wav", ".ogg", ".m4a", ".aac"];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext) || file.mimetype.startsWith("audio/")) cb(null, true);
    else cb(new Error("Only audio files are allowed"));
  },
});

function tid(req: Request): string { return (req as any).tenantId as string; }
function uid(req: Request): string { return (req as any).user?.sub as string; }
function role(req: Request): string { return (req as any).user?.role ?? ""; }
function canWrite(r: string): boolean { return ["SUPER_ADMIN", "TENANT_ADMIN", "ORG_ADMIN"].includes(r); }
function baseUrl(): string { return process.env.BASE_URL ?? "https://api.schoollive.hu"; }
function paramId(req: Request): string { return String(req.params.id); }

async function getAudioDurationSec(filePath: string): Promise<number | null> {
  try {
    const meta = await mm.parseFile(filePath, { duration: true });
    const dur  = meta.format.duration;
    return typeof dur === "number" && isFinite(dur) ? Math.round(dur) : null;
  } catch { return null; }
}

// ═══════════════════════════════════════════════════════════════════════════
// FÁJLKEZELÉS
// ═══════════════════════════════════════════════════════════════════════════

router.get("/files", authJwt, requireTenant, async (req: Request, res: Response) => {
  try {
    if (!canWrite(role(req))) return res.status(403).json({ error: "Forbidden" });
    const files = await prisma.radioFile.findMany({
      where:   { tenantId: tid(req) },
      orderBy: { createdAt: "desc" },
      include: {
        createdBy: { select: { id: true, displayName: true, email: true } },
        schedules: { select: { id: true } },
      },
    });
    const result = files.map(f => ({ ...f, _count: { schedules: f.schedules.length }, schedules: undefined }));
    return res.json({ ok: true, files: result });
  } catch (err) { console.error(err); return res.status(500).json({ error: "Failed to fetch radio files" }); }
});

router.post("/files", authJwt, requireTenant, upload.single("file"), async (req: Request, res: Response) => {
  try {
    if (!canWrite(role(req))) { if (req.file) fs.unlinkSync(req.file.path); return res.status(403).json({ error: "Forbidden" }); }
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });
    const durationSec = await getAudioDurationSec(req.file.path);
    const fileUrl     = `${baseUrl()}/uploads/radio/${req.file.filename}`;
    const radioFile = await prisma.radioFile.create({
      data: { tenantId: tid(req), createdById: uid(req), filename: req.file.filename,
              originalName: fixEncoding(req.file.originalname), sizeBytes: req.file.size, durationSec, fileUrl },
      include: { createdBy: { select: { id: true, displayName: true, email: true } } },
    });
    return res.status(201).json({ ok: true, file: { ...radioFile, _count: { schedules: 0 } } });
  } catch (err: any) {
    if (req.file) { try { fs.unlinkSync(req.file.path); } catch {} }
    if (err?.code === "P2002") return res.status(409).json({ error: "File already exists" });
    console.error(err); return res.status(500).json({ error: "Upload failed" });
  }
});

router.delete("/files/:id", authJwt, requireTenant, async (req: Request, res: Response) => {
  try {
    if (!canWrite(role(req))) return res.status(403).json({ error: "Forbidden" });
    const id   = paramId(req);
    const file = await prisma.radioFile.findFirst({ where: { id, tenantId: tid(req) } });
    if (!file) return res.status(404).json({ error: "File not found" });
    const schedCount = await prisma.radioSchedule.count({ where: { radioFileId: id } });
    const filePath = path.join(RADIO_UPLOAD_DIR, file.filename);
    if (fs.existsSync(filePath)) { try { fs.unlinkSync(filePath); } catch (e) { console.warn("[RADIO] Could not delete physical file:", e); } }
    await (prisma as any).youtubePlaylist.updateMany({ where: { radioFileId: file.id }, data: { radioFileId: null, status: "IDLE" } });
    await prisma.radioFile.delete({ where: { id: file.id } });
    return res.json({ ok: true, deletedSchedules: schedCount });
  } catch (err) { console.error(err); return res.status(500).json({ error: "Failed to delete file" }); }
});

// ═══════════════════════════════════════════════════════════════════════════
// ÜTEMEZÉSEK
// ═══════════════════════════════════════════════════════════════════════════

router.get("/schedules", authJwt, requireTenant, async (req: Request, res: Response) => {
  try {
    if (!canWrite(role(req))) return res.status(403).json({ error: "Forbidden" });
    const from = req.query.from ? new Date(req.query.from as string) : undefined;
    const to   = req.query.to   ? new Date(req.query.to   as string) : undefined;
    const schedules = await prisma.radioSchedule.findMany({
      where: { tenantId: tid(req), ...(from || to ? { scheduledAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}) },
      orderBy: { scheduledAt: "asc" },
      include: {
        radioFile: { select: { id: true, originalName: true, filename: true, durationSec: true, fileUrl: true, sizeBytes: true } },
        createdBy: { select: { id: true, displayName: true, email: true } },
      },
    });
    return res.json({ ok: true, schedules });
  } catch (err) { console.error(err); return res.status(500).json({ error: "Failed to fetch schedules" }); }
});

router.post("/schedules", authJwt, requireTenant, async (req: Request, res: Response) => {
  try {
    if (!canWrite(role(req))) return res.status(403).json({ error: "Forbidden" });
    const { radioFileId, targetType, targetId, scheduledAt } = req.body ?? {};
    if (!radioFileId || !targetType || !scheduledAt) return res.status(400).json({ error: "radioFileId, targetType and scheduledAt are required" });
    const scheduledDate = new Date(scheduledAt);
    if (isNaN(scheduledDate.getTime())) return res.status(400).json({ error: "Invalid scheduledAt date" });
    if (scheduledDate < new Date())     return res.status(400).json({ error: "scheduledAt must be in the future" });
    const file = await prisma.radioFile.findFirst({ where: { id: String(radioFileId), tenantId: tid(req) }, select: { id: true, durationSec: true } });
    if (!file) return res.status(404).json({ error: "Radio file not found" });
    if (file.durationSec) {
      const endTime    = new Date(scheduledDate.getTime() + file.durationSec * 1000);
      const candidates = await prisma.radioSchedule.findMany({
        where: { tenantId: tid(req), status: { in: ["PENDING", "DISPATCHED"] }, targetType: targetType as any, ...(targetId ? { targetId: String(targetId) } : {}), scheduledAt: { lt: endTime } },
        include: { radioFile: { select: { durationSec: true, originalName: true } } },
        orderBy: { scheduledAt: "asc" },
      });
      for (const conflict of candidates) {
        const conflictEnd = conflict.radioFile.durationSec ? new Date(conflict.scheduledAt.getTime() + conflict.radioFile.durationSec * 1000) : null;
        if (conflict.status === "DISPATCHED" && conflictEnd && conflictEnd < new Date()) continue;
        if (!conflictEnd || conflictEnd > scheduledDate) {
          return res.status(409).json({ error: "Időütközés", conflict: { id: conflict.id, scheduledAt: conflict.scheduledAt, originalName: conflict.radioFile.originalName, status: conflict.status } });
        }
      }
    }
    const schedule = await prisma.radioSchedule.create({
      data: { tenantId: tid(req), createdById: uid(req), radioFileId: file.id, targetType: targetType as any, targetId: targetId ? String(targetId) : null, scheduledAt: scheduledDate, status: "PENDING" },
      include: { radioFile: { select: { id: true, originalName: true, durationSec: true, fileUrl: true } } },
    });
    return res.status(201).json({ ok: true, schedule });
  } catch (err) { console.error(err); return res.status(500).json({ error: "Failed to create schedule" }); }
});

router.patch("/schedules/:id", authJwt, requireTenant, async (req: Request, res: Response) => {
  try {
    if (!canWrite(role(req))) return res.status(403).json({ error: "Forbidden" });
    const id       = paramId(req);
    const existing = await prisma.radioSchedule.findFirst({ where: { id, tenantId: tid(req) } });
    if (!existing)                    return res.status(404).json({ error: "Schedule not found" });
    if (existing.status !== "PENDING") return res.status(400).json({ error: "Only PENDING schedules can be modified" });
    const { scheduledAt, targetType, targetId } = req.body ?? {};
    const data: Record<string, unknown> = {};
    if (scheduledAt) {
      const d = new Date(scheduledAt);
      if (isNaN(d.getTime())) return res.status(400).json({ error: "Invalid scheduledAt" });
      if (d < new Date())     return res.status(400).json({ error: "scheduledAt must be in the future" });
      data.scheduledAt = d;
    }
    if (targetType) data.targetType = targetType;
    if (typeof targetId !== "undefined") data.targetId = targetId ?? null;
    if (Object.keys(data).length === 0) return res.status(400).json({ error: "No changes provided" });
    const updated = await prisma.radioSchedule.update({ where: { id: existing.id }, data, include: { radioFile: { select: { id: true, originalName: true, durationSec: true, fileUrl: true } } } });
    return res.json({ ok: true, schedule: updated });
  } catch (err) { console.error(err); return res.status(500).json({ error: "Failed to update schedule" }); }
});

router.delete("/schedules/:id", authJwt, requireTenant, async (req: Request, res: Response) => {
  try {
    if (!canWrite(role(req))) return res.status(403).json({ error: "Forbidden" });
    const id       = paramId(req);
    const existing = await prisma.radioSchedule.findFirst({ where: { id, tenantId: tid(req) } });
    if (!existing) return res.status(404).json({ error: "Schedule not found" });
    await prisma.radioSchedule.delete({ where: { id: existing.id } });
    return res.json({ ok: true });
  } catch (err) { console.error(err); return res.status(500).json({ error: "Failed to delete schedule" }); }
});

// ═══════════════════════════════════════════════════════════════════════════
// CÉLVÁLASZTÓ
// ═══════════════════════════════════════════════════════════════════════════

router.get("/targets", authJwt, requireTenant, async (req: Request, res: Response) => {
  try {
    if (!canWrite(role(req))) return res.status(403).json({ error: "Forbidden" });
    const [devices, groups] = await Promise.all([
      prisma.device.findMany({ where: { tenantId: tid(req) }, select: { id: true, name: true, online: true, deviceClass: true }, orderBy: { name: "asc" } }),
      prisma.deviceGroup.findMany({ where: { tenantId: tid(req) }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    ]);
    return res.json({ ok: true, devices, groups });
  } catch (err) { console.error(err); return res.status(500).json({ error: "Failed to fetch targets" }); }
});

export default router;

// ═══════════════════════════════════════════════════════════════════════════
// YOUTUBE LEJÁTSZÁSI LISTÁK
// ═══════════════════════════════════════════════════════════════════════════

const YT_DLP_BIN = process.env.YT_DLP_BIN
  ?? (() => {
    const candidates = ["/home/deploy/.local/bin/yt-dlp", "/home/balazs/.local/bin/yt-dlp", "/usr/local/bin/yt-dlp", "/usr/bin/yt-dlp"];
    const { existsSync } = require("fs");
    return candidates.find((p: string) => existsSync(p)) ?? "yt-dlp";
  })();

function runCmd(bin: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = _spawn(bin, args);
    let out = ""; let err = "";
    proc.stdout.on("data", (d: Buffer) => { out += d.toString(); });
    proc.stderr.on("data", (d: Buffer) => { err += d.toString(); });
    proc.on("close", (code: number) => { if (code !== 0) return reject(new Error(`${bin} exited ${code}: ${err.slice(-300)}`)); resolve(out.trim()); });
    proc.on("error", (e: Error) => reject(new Error(`spawn error: ${e.message}`)));
  });
}

function isYoutubeUrl(url: string): boolean {
  return /^https?:\/\/(www\.)?(youtube\.com\/(watch|shorts)|youtu\.be\/)/.test(url.trim());
}

router.get("/ytplaylists", authJwt, requireTenant, async (req: Request, res: Response) => {
  try {
    const playlists = await (prisma as any).youtubePlaylist.findMany({ where: { tenantId: tid(req) }, include: { items: { orderBy: { sortOrder: "asc" } } }, orderBy: { createdAt: "desc" } });
    return res.json({ ok: true, playlists });
  } catch (err) { console.error(err); return res.status(500).json({ error: "Failed to fetch playlists" }); }
});

router.post("/ytplaylists", authJwt, requireTenant, async (req: Request, res: Response) => {
  try {
    if (!canWrite(role(req))) return res.status(403).json({ error: "Forbidden" });
    const { name, items } = req.body as { name?: string; items?: { youtubeUrl: string; title?: string }[] };
    if (!name?.trim()) return res.status(400).json({ error: "name is required" });
    if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: "items array required" });
    for (const item of items) { if (!isYoutubeUrl(item.youtubeUrl)) return res.status(400).json({ error: `Érvénytelen YouTube URL: ${item.youtubeUrl}` }); }
    const playlist = await (prisma as any).youtubePlaylist.create({ data: { tenantId: tid(req), name: name.trim(), createdById: uid(req), items: { create: items.map((item, i) => ({ youtubeUrl: item.youtubeUrl.trim(), title: item.title?.trim() ?? null, sortOrder: i })) } }, include: { items: { orderBy: { sortOrder: "asc" } } } });
    return res.status(201).json({ ok: true, playlist });
  } catch (err) { console.error(err); return res.status(500).json({ error: "Failed to create playlist" }); }
});

router.patch("/ytplaylists/:id", authJwt, requireTenant, async (req: Request, res: Response) => {
  try {
    if (!canWrite(role(req))) return res.status(403).json({ error: "Forbidden" });
    const id = paramId(req);
    const existing = await (prisma as any).youtubePlaylist.findFirst({ where: { id, tenantId: tid(req) } });
    if (!existing) return res.status(404).json({ error: "Not found" });
    if (existing.status === "BUILDING") return res.status(409).json({ error: "Build folyamatban" });
    const { name, items } = req.body as { name?: string; items?: { youtubeUrl: string; title?: string }[] };
    const data: any = { status: "IDLE", errorMsg: null, radioFileId: null, updatedAt: new Date() };
    if (name?.trim()) data.name = name.trim();
    await (prisma as any).youtubePlaylist.update({ where: { id }, data });
    if (Array.isArray(items)) {
      for (const item of items) { if (!isYoutubeUrl(item.youtubeUrl)) return res.status(400).json({ error: `Érvénytelen YouTube URL: ${item.youtubeUrl}` }); }
      await (prisma as any).youtubePlaylistItem.deleteMany({ where: { playlistId: id } });
      await (prisma as any).youtubePlaylistItem.createMany({ data: items.map((item, i) => ({ playlistId: id, youtubeUrl: item.youtubeUrl.trim(), title: item.title?.trim() ?? null, sortOrder: i })) });
    }
    const updated = await (prisma as any).youtubePlaylist.findFirst({ where: { id }, include: { items: { orderBy: { sortOrder: "asc" } } } });
    return res.json({ ok: true, playlist: updated });
  } catch (err) { console.error(err); return res.status(500).json({ error: "Failed to update playlist" }); }
});

router.delete("/ytplaylists/:id", authJwt, requireTenant, async (req: Request, res: Response) => {
  try {
    if (!canWrite(role(req))) return res.status(403).json({ error: "Forbidden" });
    const id = paramId(req);
    const existing = await (prisma as any).youtubePlaylist.findFirst({ where: { id, tenantId: tid(req) } });
    if (!existing) return res.status(404).json({ error: "Not found" });
    await (prisma as any).youtubePlaylist.delete({ where: { id } });
    return res.json({ ok: true });
  } catch (err) { console.error(err); return res.status(500).json({ error: "Failed to delete playlist" }); }
});

router.post("/ytplaylists/:id/build", authJwt, requireTenant, async (req: Request, res: Response) => {
  try {
    if (!canWrite(role(req))) return res.status(403).json({ error: "Forbidden" });
    const id = paramId(req);
    const playlist = await (prisma as any).youtubePlaylist.findFirst({ where: { id, tenantId: tid(req) }, include: { items: { orderBy: { sortOrder: "asc" } } } });
    if (!playlist) return res.status(404).json({ error: "Not found" });
    if (playlist.status === "BUILDING") return res.status(409).json({ error: "Már folyamatban van a build" });
    if (playlist.items.length === 0) return res.status(400).json({ error: "Nincs elem a listában" });
    await (prisma as any).youtubePlaylist.update({ where: { id }, data: { status: "BUILDING", errorMsg: null, updatedAt: new Date() } });
    buildYoutubePlaylist(id, playlist, tid(req), uid(req)).catch(async (err) => {
      console.error(`[YT-BUILD] Fatal error for playlist ${id}:`, err);
      await (prisma as any).youtubePlaylist.update({ where: { id }, data: { status: "ERROR", errorMsg: String(err?.message ?? err), updatedAt: new Date() } }).catch(() => {});
    });
    return res.json({ ok: true, status: "BUILDING" });
  } catch (err) { console.error(err); return res.status(500).json({ error: "Failed to start build" }); }
});

router.get("/ytplaylists/:id/status", authJwt, requireTenant, async (req: Request, res: Response) => {
  try {
    const id = paramId(req);
    const playlist = await (prisma as any).youtubePlaylist.findFirst({ where: { id, tenantId: tid(req) }, select: { id: true, status: true, errorMsg: true, radioFileId: true, updatedAt: true } });
    if (!playlist) return res.status(404).json({ error: "Not found" });
    return res.json({ ok: true, ...playlist });
  } catch (err) { console.error(err); return res.status(500).json({ error: "Failed to fetch status" }); }
});

async function buildYoutubePlaylist(playlistId: string, playlist: any, tenantId: string, createdById: string): Promise<void> {
  const tmpDir     = path.join(RADIO_UPLOAD_DIR, `yt_tmp_${playlistId}`);
  const concatFile = path.join(tmpDir, "concat.txt");
  fs.mkdirSync(tmpDir, { recursive: true });
  try {
    const downloadedFiles: string[] = [];
    for (let i = 0; i < playlist.items.length; i++) {
      const item    = playlist.items[i];
      const outTmpl = path.join(tmpDir, `track_${String(i).padStart(3,"0")}.%(ext)s`);
      await runCmd(YT_DLP_BIN, ["--extract-audio","--audio-format","mp3","--audio-quality","128K","--no-playlist","--output",outTmpl,"--no-warnings",item.youtubeUrl]);
      const files = fs.readdirSync(tmpDir).filter(f => f.startsWith(`track_${String(i).padStart(3,"0")}`));
      if (files.length === 0) throw new Error(`yt-dlp: letöltés sikertelen: ${item.youtubeUrl}`);
      downloadedFiles.push(path.join(tmpDir, files[0]));
    }
    fs.writeFileSync(concatFile, downloadedFiles.map(f => `file '${f}'`).join("\n"));
    const hash       = crypto.randomBytes(12).toString("hex");
    const filename   = `radio_yt_${hash}.mp3`;
    const outputPath = path.join(RADIO_UPLOAD_DIR, filename);
    await runCmd("ffmpeg", ["-y","-f","concat","-safe","0","-i",concatFile,"-codec:a","libmp3lame","-b:a","128k","-id3v2_version","3",outputPath]);
    if (!fs.existsSync(outputPath)) throw new Error("ffmpeg: kimeneti MP3 nem jött létre");
    const sizeBytes   = fs.statSync(outputPath).size;
    const durationSec = await getAudioDurationSec(outputPath);
    const fileUrl     = `${baseUrl()}/uploads/radio/${filename}`;
    const radioFile   = await prisma.radioFile.create({ data: { tenantId, filename, originalName: `${playlist.name}.mp3`, sizeBytes, durationSec, fileUrl, createdById } });
    await (prisma as any).youtubePlaylist.update({ where: { id: playlistId }, data: { status: "DONE", radioFileId: radioFile.id, updatedAt: new Date() } });
    console.log(`[YT-BUILD] ✅ Done! ${filename}`);
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// VÉSZLEÁLLÍTÓ – JAVÍTOTT: stopRadioImmediate hívása
// ═══════════════════════════════════════════════════════════════════════════

// POST /radio/stop-all
// Azonnali leállítás: pending timeoutok törlése + Snapcast stop + STOP_PLAYBACK broadcast
router.post("/stop-all", authJwt, requireTenant, async (req: Request, res: Response) => {
  try {
    if (!canWrite(role(req))) return res.status(403).json({ error: "Forbidden" });

    const { stopRadioImmediate } = await import("./radio.scheduler");

    // Teljes leállítás: scheduler timeoutok + Snapcast + SyncEngine broadcast
    await stopRadioImmediate(tid(req));

    // Offline eszközök DB queue-ba
    const allDevices = await prisma.device.findMany({ where: { tenantId: tid(req) }, select: { id: true } });
    const { SyncEngine } = await import("../../sync/SyncEngine");
    const offlineIds = allDevices.map(d => d.id).filter(id => !SyncEngine.isDeviceOnline(id));

    if (offlineIds.length > 0) {
      await prisma.deviceCommand.createMany({
        data: offlineIds.map(deviceId => ({
          tenantId: tid(req), deviceId, status: "QUEUED" as const,
          payload: { action: "STOP_PLAYBACK" },
        })),
      });
    }

    // Éppen játszó schedule-ök CANCELLED-re állítása
    const now        = new Date();
    const dispatched = await prisma.radioSchedule.findMany({
      where:   { tenantId: tid(req), status: "DISPATCHED", dispatchedAt: { not: null } },
      include: { radioFile: { select: { durationSec: true } } },
    });
    const stillPlaying = dispatched.filter(s => {
      if (!s.dispatchedAt) return false;
      return now < new Date(s.dispatchedAt.getTime() + (s.radioFile.durationSec ?? 0) * 1000);
    });
    if (stillPlaying.length > 0) {
      await prisma.radioSchedule.updateMany({
        where: { id: { in: stillPlaying.map(s => s.id) } },
        data:  { status: "CANCELLED" },
      });
    }

    console.log(`[RADIO] STOP-ALL: ${allDevices.length} eszköz, ${offlineIds.length} offline DB queue`);
    return res.json({ ok: true, sent: allDevices.length });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Failed to stop playback" });
  }
});

// GET /radio/now-playing
router.get("/now-playing", authJwt, requireTenant, async (req: Request, res: Response) => {
  try {
    const vpDevices = await prisma.device.findMany({ where: { tenantId: tid(req), authType: "JWT" }, select: { id: true, name: true, online: true, lastSeenAt: true } });
    if (vpDevices.length === 0) return res.json({ ok: true, nowPlaying: null, devices: [] });
    const deviceIds = vpDevices.map(d => d.id);
    const since     = new Date(Date.now() - 6 * 60 * 60 * 1000);
    const cmd = await prisma.deviceCommand.findFirst({
      where: { deviceId: { in: deviceIds }, status: { in: ["SENT", "ACKED"] }, queuedAt: { gte: since }, payload: { path: ["action"], array_contains: undefined } as any },
      orderBy: { queuedAt: "desc" },
    });
    let nowPlaying: { name: string; durationSec: number | null; queuedAt: string } | null = null;
    if (cmd) {
      const payload = cmd.payload as any;
      if (payload?.action === "PLAY_URL" || payload?.action === "TTS") {
        let name: string = payload?.title ?? payload?.url?.split("/").pop() ?? "Ismeretlen";
        let durationSec: number | null = null;
        if (cmd.messageId) {
          const msg = await prisma.message.findUnique({ where: { id: cmd.messageId }, select: { title: true } });
          if (msg?.title) name = msg.title;
        } else if (payload?.url) {
          const filename = payload.url.split("/").pop()?.split("?")[0] ?? "";
          if (filename) {
            const rf = await prisma.radioFile.findFirst({ where: { tenantId: tid(req), filename }, select: { originalName: true, durationSec: true } });
            if (rf) { name = rf.originalName; durationSec = rf.durationSec; }
          }
        }
        nowPlaying = { name, durationSec, queuedAt: cmd.queuedAt.toISOString() };
      }
    }
    return res.json({ ok: true, nowPlaying });
  } catch (err) { console.error(err); return res.status(500).json({ error: "Failed to fetch now playing" }); }
});

// ═══════════════════════════════════════════════════════════════════════════
// PLAYLIST BUILDER – ÚJ ENDPOINTOK
// ═══════════════════════════════════════════════════════════════════════════

const buildStatusMap = new Map<string, { status: "BUILDING"|"DONE"|"ERROR"; fileUrl?: string; name?: string; errorMsg?: string }>();

router.get("/yt-info", authJwt, requireTenant, async (req: Request, res: Response) => {
  const url = String(req.query.url ?? "").trim();
  if (!url) return res.status(400).json({ ok: false, error: "url required" });
  try {
    const out = await runCmd(YT_DLP_BIN, ["--print","%(title)s|||%(duration)s","--no-playlist","--no-warnings","--skip-download",url]);
    const [title, durationRaw] = out.split("|||");
    const durationSec = Math.round(parseFloat(durationRaw));
    if (!title || isNaN(durationSec)) return res.status(422).json({ ok: false, error: "Nem sikerült kiolvasni az adatokat" });
    return res.json({ ok: true, title: title.trim(), durationSec });
  } catch (err: any) { console.error("[yt-info]", err?.message); return res.status(422).json({ ok: false, error: "Nem sikerült betölteni a videó adatait" }); }
});

router.get("/yt-search", authJwt, requireTenant, async (req: Request, res: Response) => {
  const q     = String(req.query.q ?? "").trim();
  const limit = Math.min(10, Math.max(1, parseInt(String(req.query.limit ?? "5"), 10) || 5));
  if (!q) return res.status(400).json({ ok: false, error: "q required" });
  try {
    const out = await runCmd(YT_DLP_BIN, [`ytsearch${limit}:${q}`,"--print","%(id)s|||%(title)s|||%(duration_string)s|||%(thumbnail)s","--flat-playlist","--no-warnings","--skip-download"]);
    const results = out.split("\n").map(line => line.trim()).filter(Boolean).map(line => { const [id,title,duration,thumbnail] = line.split("|||"); return { id: id?.trim(), title: title?.trim(), duration: duration?.trim() ?? "?:??", thumbnail: thumbnail?.trim() ?? "" }; }).filter(r => r.id && r.title);
    return res.json({ ok: true, results });
  } catch (err: any) { console.error("[yt-search]", err?.message); return res.json({ ok: true, results: [] }); }
});

router.get("/gdrive-files", authJwt, requireTenant, async (req: Request, res: Response) => {
  const url = String(req.query.url ?? "").trim();
  if (!url) return res.status(400).json({ ok: false, error: "url required" });
  const isFolderUrl = /\/drive\/folders\//.test(url);
  try {
    if (isFolderUrl) {
      const out = await runCmd(YT_DLP_BIN, [url,"--flat-playlist","--print","%(title)s|||%(url)s|||%(duration)s","--no-warnings","--skip-download"]);
      const files = out.split("\n").map(l => l.trim()).filter(Boolean).map(line => { const [name,fileUrl,durRaw] = line.split("|||"); const durationSec = durRaw ? Math.round(parseFloat(durRaw)) || null : null; return { name: name?.trim() ?? "Ismeretlen", url: fileUrl?.trim() ?? "", durationSec }; }).filter(f => f.url && /\.(mp3|wav|ogg|m4a|aac|flac)/i.test(f.name));
      return res.json({ ok: true, files });
    } else {
      const out = await runCmd(YT_DLP_BIN, [url,"--print","%(title)s|||%(url)s|||%(duration)s","--no-warnings","--skip-download"]);
      const [name,fileUrl,durRaw] = out.trim().split("|||");
      const durationSec = durRaw ? Math.round(parseFloat(durRaw)) || null : null;
      return res.json({ ok: true, files: [{ name: name?.trim() ?? "Hangfájl", url: fileUrl?.trim() ?? url, durationSec }] });
    }
  } catch (err: any) { console.error("[gdrive-files]", err?.message); return res.status(422).json({ ok: false, error: "Nem sikerült betölteni a Drive fájlokat." }); }
});

router.post("/files/trim", authJwt, requireTenant, async (req: Request, res: Response) => {
  if (!canWrite(role(req))) return res.status(403).json({ error: "Forbidden" });
  const { fileId, trimSec, fadeOut = 5 } = req.body as { fileId: string; trimSec: number; fadeOut?: number };
  if (!fileId || !trimSec) return res.status(400).json({ error: "fileId és trimSec kötelező" });
  try {
    const radioFile = await prisma.radioFile.findFirst({ where: { id: fileId, tenantId: tid(req) } });
    if (!radioFile) return res.status(404).json({ error: "Fájl nem található" });
    const inputPath = path.join(RADIO_UPLOAD_DIR, radioFile.filename);
    if (!fs.existsSync(inputPath)) return res.status(404).json({ error: "Fájl nem található a szerveren" });
    const hash       = crypto.randomBytes(12).toString("hex");
    const filename   = `radio_${hash}_edited.mp3`;
    const outputPath = path.join(RADIO_UPLOAD_DIR, filename);
    const fadeStart  = Math.max(0, trimSec - fadeOut);
    await runCmd("ffmpeg", ["-y","-i",inputPath,"-t",String(trimSec),"-af",`afade=t=out:st=${fadeStart}:d=${fadeOut}`,"-codec:a","libmp3lame","-b:a","128k",outputPath]);
    const sizeBytes   = fs.statSync(outputPath).size;
    const durationSec = await getAudioDurationSec(outputPath);
    const fileUrl     = `${baseUrl()}/uploads/radio/${filename}`;
    const baseName    = radioFile.originalName.replace(/\.mp3$/i, "");
    const editedName  = fixEncoding(`${baseName}-edited.mp3`);
    const newFile = await prisma.radioFile.create({ data: { tenantId: tid(req), createdById: uid(req), filename, originalName: editedName, sizeBytes, durationSec, fileUrl } });
    return res.json({ ok: true, fileId: newFile.id, filename: editedName, fileUrl, durationSec });
  } catch (err: any) { console.error("[trim]", err?.message); return res.status(500).json({ error: "Vágás sikertelen: " + (err?.message ?? "") }); }
});

router.post("/ytplaylists/build-custom", authJwt, requireTenant, async (req: Request, res: Response) => {
  if (!canWrite(role(req))) return res.status(403).json({ error: "Forbidden" });
  const { name, items } = req.body as { name: string; items: Array<{ url: string; title: string; source: "youtube" | "gdrive" | "upload" }> };
  if (!name?.trim() || !items?.length) return res.status(400).json({ error: "name és items kötelező" });
  const buildId = crypto.randomBytes(12).toString("hex");
  buildStatusMap.set(buildId, { status: "BUILDING" });
  (async () => {
    const tmpDir = path.join(RADIO_UPLOAD_DIR, `custom_tmp_${buildId}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    try {
      const downloadedFiles: string[] = [];
      const tenantId = tid(req); const createdById = uid(req);
      for (let i = 0; i < items.length; i++) {
        const item = items[i]; const outBase = path.join(tmpDir, `track_${String(i).padStart(3,"0")}`);
        if (item.source === "youtube" || item.source === "gdrive") {
          await runCmd(YT_DLP_BIN, ["--extract-audio","--audio-format","mp3","--audio-quality","128K","--no-playlist","--output",`${outBase}.%(ext)s`,"--no-warnings",item.url]);
          const found = fs.readdirSync(tmpDir).find(f => f.startsWith(`track_${String(i).padStart(3,"0")}`));
          if (!found) throw new Error(`letöltés sikertelen: ${item.url}`);
          downloadedFiles.push(path.join(tmpDir, found));
        } else {
          const localFilename = item.url.split("/").pop()?.split("?")[0];
          const localPath = localFilename ? path.join(RADIO_UPLOAD_DIR, localFilename) : null;
          if (localPath && fs.existsSync(localPath)) { const dest = `${outBase}.mp3`; fs.copyFileSync(localPath, dest); downloadedFiles.push(dest); }
          else if (item.url.startsWith("http")) {
            const https = await import("https"); const http = await import("http");
            const dest = `${outBase}.mp3`;
            await new Promise<void>((resolve, reject) => { const mod = item.url.startsWith("https") ? https.default : http.default; const file = fs.createWriteStream(dest); mod.get(item.url, resp => { resp.pipe(file); file.on("finish", () => { file.close(); resolve(); }); }).on("error", reject); });
            downloadedFiles.push(dest);
          } else throw new Error(`Ismeretlen forrás: ${item.url}`);
        }
      }
      const concatFile = path.join(tmpDir, "concat.txt");
      fs.writeFileSync(concatFile, downloadedFiles.map(f => `file '${f}'`).join("\n"));
      const hash = crypto.randomBytes(12).toString("hex"); const filename = `radio_custom_${hash}.mp3`; const outputPath = path.join(RADIO_UPLOAD_DIR, filename);
      await runCmd("ffmpeg", ["-y","-f","concat","-safe","0","-i",concatFile,"-codec:a","libmp3lame","-b:a","128k",outputPath]);
      const sizeBytes = fs.statSync(outputPath).size; const durationSec = await getAudioDurationSec(outputPath); const fileUrl = `${baseUrl()}/uploads/radio/${filename}`;
      const radioFile = await prisma.radioFile.create({ data: { tenantId, createdById, filename, originalName: fixEncoding(`${name.trim()}.mp3`), sizeBytes, durationSec, fileUrl } });
      buildStatusMap.set(buildId, { status: "DONE", fileUrl, name: radioFile.originalName });
      buildStatusMap.set(`${buildId}_fileId`, { status: "DONE", fileUrl, name: radioFile.id });
    } catch (err: any) { console.error("[CUSTOM-BUILD] Error:", err?.message); buildStatusMap.set(buildId, { status: "ERROR", errorMsg: err?.message }); }
    finally { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} }
  })();
  return res.json({ ok: true, fileId: buildId });
});

router.get("/ytplaylists/build-status/:fileId", authJwt, requireTenant, async (req: Request, res: Response) => {
  const buildId = String(req.params.fileId);
  const status  = buildStatusMap.get(buildId);
  if (!status) return res.status(404).json({ ok: false, error: "Nincs ilyen build" });
  let fileId: string | undefined;
  if (status.status === "DONE") fileId = buildStatusMap.get(`${buildId}_fileId`)?.name;
  return res.json({ ok: true, status: status.status, fileUrl: status.fileUrl, name: status.name, fileId, errorMsg: status.errorMsg });
});
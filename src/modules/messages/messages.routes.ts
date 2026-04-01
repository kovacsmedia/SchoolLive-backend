// src/modules/messages/messages.routes.ts
import { Router, Request, Response } from "express";
import { prisma }          from "../../prisma/client";
import { authJwt }         from "../../middleware/authJwt";
import { requireTenant }   from "../../middleware/tenant";
import { generateTTS }     from "../../services/tts.service";
import { SyncEngine }      from "../../sync/SyncEngine";
import { SnapcastService } from "../snapcast/snapcast.service";
import { randomUUID }      from "crypto";
import multer              from "multer";
import path                from "path";
import fs                  from "fs";

const router = Router();

const AUDIO_DIR = path.join(process.cwd(), "audio");
if (!fs.existsSync(AUDIO_DIR)) fs.mkdirSync(AUDIO_DIR, { recursive: true });

// Multer – hangfelvétel feltöltéshez
const audioUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, AUDIO_DIR),
    filename:    (_req, _file, cb) => cb(null, `rec_${randomUUID()}.webm`),
  }),
  limits:      { fileSize: 50 * 1024 * 1024 },
  fileFilter:  (_req, file, cb) => {
    const ok = file.mimetype.startsWith("audio/");
    cb(ok ? null : new Error("Only audio files allowed"), ok);
  },
});

function tenantId(req: Request): string { return (req as any).tenantId as string; }
function userId(req: Request):   string { return (req as any).user?.sub as string; }

async function resolveDeviceIds(tid: string, targetType: string, targetId?: string): Promise<string[] | null> {
  if (targetType === "ALL") return null;
  if (targetType === "DEVICE" && targetId) return [targetId];
  if (targetType === "GROUP" && targetId) {
    return (await prisma.deviceGroupMember.findMany({ where: { groupId: targetId }, select: { deviceId: true } })).map(m => m.deviceId);
  }
  if (targetType === "ORG_UNIT" && targetId) {
    return (await prisma.device.findMany({ where: { tenantId: tid, orgUnitId: targetId, online: true }, select: { id: true } })).map(d => d.id);
  }
  return [];
}

async function getCandidateIds(tid: string, targetIds: string[] | null): Promise<string[]> {
  if (targetIds === null) {
    return (await prisma.device.findMany({ where: { tenantId: tid, online: true }, select: { id: true } })).map(d => d.id);
  }
  return targetIds;
}

// GET /messages
router.get("/", authJwt, requireTenant, async (req: Request, res: Response) => {
  try {
    const tid   = tenantId(req);
    const page  = Math.max(1, parseInt(String(req.query.page  ?? "1"),  10));
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit ?? "20"), 10)));
    const skip  = (page - 1) * limit;
    const where: any = { tenantId: tid };
    if (req.query.type) where.type = req.query.type;
    const [messages, total] = await Promise.all([
      prisma.message.findMany({
        where, orderBy: { createdAt: "desc" }, skip, take: limit,
        select: {
          id: true, title: true, text: true, type: true, voice: true,
          fileUrl: true, targetType: true, targetId: true,
          scheduledAt: true, playedAt: true, createdAt: true,
          createdBy: { select: { id: true, displayName: true, email: true } },
        },
      }),
      prisma.message.count({ where }),
    ]);
    return res.json({ ok: true, messages, total, page, limit });
  } catch (err) { console.error(err); return res.status(500).json({ error: "Failed to fetch messages" }); }
});

// GET /messages/templates
router.get("/templates", authJwt, requireTenant, async (req: Request, res: Response) => {
  try {
    const templates = await prisma.messageTemplate.findMany({
      where:   { tenantId: tenantId(req), userId: userId(req) },
      orderBy: { createdAt: "desc" },
      select:  { id: true, name: true, text: true, voice: true, createdAt: true },
    });
    return res.json({ ok: true, templates });
  } catch (err) { console.error(err); return res.status(500).json({ error: "Failed to fetch templates" }); }
});

// POST /messages/templates
router.post("/templates", authJwt, requireTenant, async (req: Request, res: Response) => {
  try {
    const { name, text, voice = "anna" } = req.body;
    if (!name || !text) return res.status(400).json({ error: "name and text are required" });
    const template = await prisma.messageTemplate.create({
      data: { name, text, voice, tenant: { connect: { id: tenantId(req) } }, user: { connect: { id: userId(req) } } },
    });
    return res.status(201).json({ ok: true, template });
  } catch (err) { console.error(err); return res.status(500).json({ error: "Failed to save template" }); }
});

// DELETE /messages/templates/:id
router.delete("/templates/:id", authJwt, requireTenant, async (req: Request, res: Response) => {
  try {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    await prisma.messageTemplate.deleteMany({ where: { id, tenantId: tenantId(req), userId: userId(req) } });
    return res.json({ ok: true });
  } catch (err) { console.error(err); return res.status(500).json({ error: "Failed to delete template" }); }
});

// POST /messages – TTS üzenet
router.post("/", authJwt, requireTenant, async (req: Request, res: Response) => {
  try {
    const tid = tenantId(req);
    const uid = userId(req);
    const { text, voice = "anna", targetType, targetId, scheduledAt } = req.body;

    if (!text?.trim())  return res.status(400).json({ error: "Text is required" });
    if (!targetType)    return res.status(400).json({ error: "targetType is required" });

    const { filename, durationMs } = await generateTTS(text.trim(), voice);
    const fileUrl       = `${process.env.BASE_URL ?? "https://api.schoollive.hu"}/audio/${filename}`;
    const scheduledTime = scheduledAt ? new Date(scheduledAt) : null;
    const isImmediate   = !scheduledTime || scheduledTime <= new Date();
    const title         = text.trim().substring(0, 64);

    const message = await prisma.message.create({
      data: { tenantId: tid, createdById: uid, type: "TTS", title, text: text.trim(), voice, fileUrl, targetType, targetId: targetId ?? null, scheduledAt: scheduledTime },
    });

    const targetIds    = await resolveDeviceIds(tid, targetType, targetId);
    if (targetIds !== null && targetIds.length === 0) return res.status(201).json({ ok: true, message });
    const candidateIds = await getCandidateIds(tid, targetIds);

    if (isImmediate) {
      const snapOnline = await SnapcastService.isSnapserverOnline(tid);
      if (snapOnline) await SnapcastService.play({ type: "TTS", source: { type: "url", url: fileUrl }, tenantId: tid, title, text: text.trim() });
      const onlineIds  = candidateIds.filter(id => SyncEngine.isDeviceOnline(id));
      const offlineIds = candidateIds.filter(id => !SyncEngine.isDeviceOnline(id));
      if (onlineIds.length > 0) {
        SyncEngine.dispatchSync({ tenantId: tid, commandId: `msg-${message.id}`, action: "TTS", url: fileUrl, text: text.trim(), title, durationMs: durationMs ?? undefined, ...(targetIds !== null && { targetDeviceIds: onlineIds }), snapcastActive: snapOnline }).catch(e => console.error("[MESSAGES] SyncEngine hiba:", e));
      }
      if (offlineIds.length > 0) {
        await prisma.deviceCommand.createMany({ data: offlineIds.map(deviceId => ({ tenantId: tid, deviceId, messageId: message.id, status: "QUEUED" as const, payload: { action: "TTS", url: fileUrl, text: text.trim(), title, scheduledAt: null } })) });
      }
    } else {
      const scheduledCandidates = targetIds === null ? (await prisma.device.findMany({ where: { tenantId: tid }, select: { id: true } })).map(d => d.id) : targetIds;
      await prisma.deviceCommand.createMany({ data: scheduledCandidates.map(deviceId => ({ tenantId: tid, deviceId, messageId: message.id, status: "QUEUED" as const, payload: { action: "TTS", url: fileUrl, text: text.trim(), title, scheduledAt: scheduledTime?.toISOString() ?? null } })) });
    }

    return res.status(201).json({ ok: true, message });
  } catch (err) { console.error(err); return res.status(500).json({ error: "Failed to create message" }); }
});

// ── POST /messages/audio – Hangfelvétel feltöltése és lejátszása ──────────────
// multipart/form-data: audio (file), targetType, targetId?, scheduledAt?
router.post("/audio", authJwt, requireTenant, audioUpload.single("audio"), async (req: Request, res: Response) => {
  try {
    const tid = tenantId(req);
    const uid = userId(req);

    if (!req.file) return res.status(400).json({ error: "Hangfájl megadása kötelező." });

    const { targetType = "ALL", targetId, scheduledAt } = req.body ?? {};
    if (!targetType) return res.status(400).json({ error: "targetType is required" });

    const fileUrl       = `${process.env.BASE_URL ?? "https://api.schoollive.hu"}/audio/${req.file.filename}`;
    const scheduledTime = scheduledAt ? new Date(scheduledAt) : null;
    const isImmediate   = !scheduledTime || scheduledTime <= new Date();
    const title         = "Hangfelvétel";

    const message = await prisma.message.create({
      data: { tenantId: tid, createdById: uid, type: "RECORDING", title, text: null, voice: null, fileUrl, targetType, targetId: targetId ?? null, scheduledAt: scheduledTime },
    });

    const targetIds    = await resolveDeviceIds(tid, targetType, targetId);
    if (targetIds !== null && targetIds.length === 0) return res.status(201).json({ ok: true, message });
    const candidateIds = await getCandidateIds(tid, targetIds);

    if (isImmediate) {
      const snapOnline = await SnapcastService.isSnapserverOnline(tid);
      if (snapOnline) await SnapcastService.play({ type: "TTS", source: { type: "url", url: fileUrl }, tenantId: tid, title });
      const onlineIds  = candidateIds.filter(id => SyncEngine.isDeviceOnline(id));
      const offlineIds = candidateIds.filter(id => !SyncEngine.isDeviceOnline(id));
      if (onlineIds.length > 0) {
        SyncEngine.dispatchSync({ tenantId: tid, commandId: `rec-${message.id}`, action: "TTS", url: fileUrl, title, ...(targetIds !== null && { targetDeviceIds: onlineIds }), snapcastActive: snapOnline }).catch(e => console.error("[MESSAGES] SyncEngine hiba:", e));
      }
      if (offlineIds.length > 0) {
        await prisma.deviceCommand.createMany({ data: offlineIds.map(deviceId => ({ tenantId: tid, deviceId, messageId: message.id, status: "QUEUED" as const, payload: { action: "TTS", url: fileUrl, title, scheduledAt: null } })) });
      }
    } else {
      const scheduledCandidates = targetIds === null ? (await prisma.device.findMany({ where: { tenantId: tid }, select: { id: true } })).map(d => d.id) : targetIds;
      await prisma.deviceCommand.createMany({ data: scheduledCandidates.map(deviceId => ({ tenantId: tid, deviceId, messageId: message.id, status: "QUEUED" as const, payload: { action: "TTS", url: fileUrl, title, scheduledAt: scheduledTime?.toISOString() ?? null } })) });
    }

    console.log(`[MESSAGES] Hangfelvétel feltöltve és elküldve: ${req.file.filename} | tenant: ${tid}`);
    return res.status(201).json({ ok: true, message });
  } catch (err) { console.error(err); return res.status(500).json({ error: "Failed to send recording" }); }
});

// POST /messages/play-url
router.post("/play-url", authJwt, requireTenant, async (req: Request, res: Response) => {
  try {
    const tid = tenantId(req);
    const { url, title = "Iskolarádió", targetType = "ALL", targetId } = req.body;
    if (!url?.trim()) return res.status(400).json({ error: "url is required" });
    const targetIds    = await resolveDeviceIds(tid, targetType, targetId);
    const candidateIds = await getCandidateIds(tid, targetIds);
    const snapOnline   = await SnapcastService.isSnapserverOnline(tid);
    if (snapOnline) await SnapcastService.play({ type: "RADIO", source: { type: "stream", url }, tenantId: tid, title, persistent: true });
    const onlineIds = candidateIds.filter(id => SyncEngine.isDeviceOnline(id));
    if (onlineIds.length > 0) {
      await SyncEngine.dispatchSync({ tenantId: tid, commandId: randomUUID(), action: "PLAY_URL", url, title, durationMs: undefined, snapcastActive: snapOnline, ...(targetIds !== null && { targetDeviceIds: onlineIds }) });
    }
    return res.json({ ok: true, snapcastActive: snapOnline });
  } catch (err) { console.error(err); return res.status(500).json({ error: "Failed to start stream" }); }
});

// POST /messages/stop
router.post("/stop", authJwt, requireTenant, async (req: Request, res: Response) => {
  try {
    const tid = tenantId(req);
    await SnapcastService.stop(tid);
    SyncEngine.broadcastImmediate(tid, { action: "STOP_PLAYBACK", commandId: randomUUID() });
    return res.json({ ok: true });
  } catch (err) { console.error(err); return res.status(500).json({ error: "Failed to stop playback" }); }
});

// GET /messages/:id
router.get("/:id", authJwt, requireTenant, async (req: Request, res: Response) => {
  try {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const message = await prisma.message.findFirst({
      where: { id, tenantId: tenantId(req) },
      include: {
        createdBy: { select: { id: true, displayName: true, email: true } },
        commands:  { select: { id: true, deviceId: true, status: true, queuedAt: true, ackedAt: true } },
      },
    });
    if (!message) return res.status(404).json({ error: "Message not found" });
    return res.json({ ok: true, message });
  } catch (err) { console.error(err); return res.status(500).json({ error: "Failed to fetch message" }); }
});

// DELETE /messages/:id
router.delete("/:id", authJwt, requireTenant, async (req: Request, res: Response) => {
  try {
    const tid  = tenantId(req);
    const user = (req as any).user;
    const id   = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    if (user?.role !== "SUPER_ADMIN" && user?.role !== "TENANT_ADMIN") return res.status(403).json({ error: "Forbidden" });
    await prisma.message.delete({ where: { id, tenantId: tid } });
    return res.json({ ok: true });
  } catch (err) { console.error(err); return res.status(500).json({ error: "Failed to delete message" }); }
});

export default router;
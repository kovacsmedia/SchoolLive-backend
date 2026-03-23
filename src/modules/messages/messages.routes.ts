// src/modules/messages/messages.routes.ts
//
// Dispatch stratégia (Snapcast alapú):
//   - Azonnali TTS/PLAY_URL: SnapcastService (audio) + SyncEngine (overlay VP-re)
//   - Ütemezett: csak DB queue (Snapcast-ot az időpontban hívja a scheduler)
//   - Offline VP fallback: DB queue
//
// resolveDeviceIds logika:
//   null  = ALL (mindenki a cél) → targetDeviceIds NEM kerül a WS üzenetbe
//   []    = senki sem célzott   → korai visszatérés, semmi nem megy ki
//   [...] = konkrét eszközök    → targetDeviceIds bekerül a WS üzenetbe

import { Router, Request, Response } from "express";
import { prisma }          from "../../prisma/client";
import { authJwt }         from "../../middleware/authJwt";
import { requireTenant }   from "../../middleware/tenant";
import { generateTTS }     from "../../services/tts.service";
import { SyncEngine }      from "../../sync/SyncEngine";
import { SnapcastService } from "../snapcast/snapcast.service";
import { randomUUID }      from "crypto";

const router = Router();

function tenantId(req: Request): string { return (req as any).tenantId as string; }
function userId(req: Request):   string { return (req as any).user?.sub as string; }

// ── resolveDeviceIds ──────────────────────────────────────────────────────────
// null=ALL, []=senki, [...]=konkrét lista
async function resolveDeviceIds(
  tid: string, targetType: string, targetId?: string
): Promise<string[] | null> {
  if (targetType === "ALL") return null;
  if (targetType === "DEVICE" && targetId) return [targetId];
  if (targetType === "GROUP" && targetId) {
    return (await prisma.deviceGroupMember.findMany({
      where:  { groupId: targetId },
      select: { deviceId: true },
    })).map(m => m.deviceId);
  }
  if (targetType === "ORG_UNIT" && targetId) {
    return (await prisma.device.findMany({
      where:  { tenantId: tid, orgUnitId: targetId, online: true },
      select: { id: true },
    })).map(d => d.id);
  }
  return [];
}

// ── getCandidateIds ───────────────────────────────────────────────────────────
// null → minden online eszköz; konkrét lista → az adott lista
async function getCandidateIds(tid: string, targetIds: string[] | null): Promise<string[]> {
  if (targetIds === null) {
    return (await prisma.device.findMany({
      where:  { tenantId: tid, online: true },
      select: { id: true },
    })).map(d => d.id);
  }
  return targetIds;
}

// GET /messages
router.get("/", authJwt, requireTenant, async (req: Request, res: Response) => {
  try {
    const tid   = tenantId(req);
    const page  = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(50, parseInt(req.query.limit as string) || 20);
    const skip  = (page - 1) * limit;
    const createdBy = req.query.createdBy as string | undefined;
    const where     = { tenantId: tid, ...(createdBy ? { createdById: createdBy } : {}) };
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
      data: { name, text, voice,
        tenant: { connect: { id: tenantId(req) } },
        user:   { connect: { id: userId(req) } },
      },
    });
    return res.status(201).json({ ok: true, template });
  } catch (err) { console.error(err); return res.status(500).json({ error: "Failed to save template" }); }
});

// DELETE /messages/templates/:id
router.delete("/templates/:id", authJwt, requireTenant, async (req: Request, res: Response) => {
  try {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const template = await prisma.messageTemplate.findFirst({
      where: { id, tenantId: tenantId(req), userId: userId(req) },
    });
    if (!template) return res.status(404).json({ error: "Template not found" });
    await prisma.messageTemplate.delete({ where: { id } });
    return res.json({ ok: true });
  } catch (err) { console.error(err); return res.status(500).json({ error: "Failed to delete template" }); }
});

// POST /messages – TTS üzenet küldése
router.post("/", authJwt, requireTenant, async (req: Request, res: Response) => {
  try {
    const tid = tenantId(req);
    const uid = userId(req);
    const { text, voice = "anna", targetType, targetId, scheduledAt } = req.body;

    if (!text?.trim())  return res.status(400).json({ error: "Text is required" });
    if (!targetType)    return res.status(400).json({ error: "targetType is required" });

    const filename      = await generateTTS(text.trim(), voice);
    const fileUrl       = `${process.env.BASE_URL ?? "https://api.schoollive.hu"}/audio/${filename}`;
    const scheduledTime = scheduledAt ? new Date(scheduledAt) : null;
    const isImmediate   = !scheduledTime || scheduledTime <= new Date();
    const title         = text.trim().substring(0, 64);

    const message = await prisma.message.create({
      data: {
        tenantId: tid, createdById: uid, type: "TTS",
        title, text: text.trim(),
        voice, fileUrl, targetType, targetId: targetId ?? null, scheduledAt: scheduledTime,
      },
    });

    const targetIds = await resolveDeviceIds(tid, targetType, targetId);
    if (targetIds !== null && targetIds.length === 0) {
      return res.status(201).json({ ok: true, message });
    }

    const candidateIds = await getCandidateIds(tid, targetIds);

    if (isImmediate) {
      // ── 1. Snapcast ──────────────────────────────────────────────────────────
      const snapOnline = await SnapcastService.isSnapserverOnline(tid);
      if (snapOnline) {
        await SnapcastService.play({
          type:     "TTS",
          source:   { type: "url", url: fileUrl },
          tenantId: tid,
          title,
          text:     text.trim(),
        });
        console.log(`[MESSAGES] 🎙 Snapcast TTS → tenant: ${tid}`);
      } else {
        console.warn(`[MESSAGES] ⚠️ Snapserver offline – csak SyncEngine fallback | tenant: ${tid}`);
      }

      // ── 2. SyncEngine ────────────────────────────────────────────────────────
      const onlineIds  = candidateIds.filter(id => SyncEngine.isDeviceOnline(id));
      const offlineIds = candidateIds.filter(id => !SyncEngine.isDeviceOnline(id));

      if (onlineIds.length > 0) {
        SyncEngine.dispatchSync({
          tenantId:  tid,
          commandId: `msg-${message.id}`,
          action:    "TTS",
          url:       fileUrl,
          text:      text.trim(),
          title,
          // ALL esetén nincs targetDeviceIds → mindenki szól, nincs önmute
          ...(targetIds !== null && { targetDeviceIds: onlineIds }),
          snapcastActive: snapOnline,
        }).catch(e => console.error("[MESSAGES] SyncEngine hiba:", e));
        console.log(`[MESSAGES] 📤 SyncEngine TTS → ${onlineIds.length} online | tenant: ${tid}`);
      }

      if (offlineIds.length > 0) {
        await prisma.deviceCommand.createMany({
          data: offlineIds.map(deviceId => ({
            tenantId: tid, deviceId, messageId: message.id, status: "QUEUED" as const,
            payload: { action: "TTS", url: fileUrl, text: text.trim(), title, scheduledAt: null },
          })),
        });
        console.log(`[MESSAGES] 📤 DB queue TTS → ${offlineIds.length} offline | tenant: ${tid}`);
      }

    } else {
      const scheduledCandidates = targetIds === null
        ? (await prisma.device.findMany({ where: { tenantId: tid }, select: { id: true } })).map(d => d.id)
        : targetIds;

      await prisma.deviceCommand.createMany({
        data: scheduledCandidates.map(deviceId => ({
          tenantId: tid, deviceId, messageId: message.id, status: "QUEUED" as const,
          payload: {
            action: "TTS", url: fileUrl, text: text.trim(), title,
            scheduledAt: scheduledTime?.toISOString() ?? null,
          },
        })),
      });
      console.log(`[MESSAGES] 📅 Ütemezett TTS → ${scheduledCandidates.length} eszköz @ ${scheduledTime?.toISOString()} | tenant: ${tid}`);
    }

    return res.status(201).json({ ok: true, message });
  } catch (err) { console.error(err); return res.status(500).json({ error: "Failed to create message" }); }
});

// POST /messages/play-url – Rádió / stream indítása
router.post("/play-url", authJwt, requireTenant, async (req: Request, res: Response) => {
  try {
    const tid = tenantId(req);
    const { url, title = "Iskolarádió", targetType = "ALL", targetId } = req.body;

    if (!url?.trim()) return res.status(400).json({ error: "url is required" });

    const targetIds    = await resolveDeviceIds(tid, targetType, targetId);
    const candidateIds = await getCandidateIds(tid, targetIds);

    // ── 1. Snapcast ──────────────────────────────────────────────────────────
    const snapOnline = await SnapcastService.isSnapserverOnline(tid);
    if (snapOnline) {
      await SnapcastService.play({
        type:       "RADIO",
        source:     { type: "stream", url },
        tenantId:   tid,
        title,
        persistent: true,
      });
      console.log(`[MESSAGES] 📻 Snapcast RADIO → tenant: ${tid} url: ${url}`);
    }

    // ── 2. SyncEngine ────────────────────────────────────────────────────────
    const onlineIds = candidateIds.filter(id => SyncEngine.isDeviceOnline(id));
    if (onlineIds.length > 0) {
      SyncEngine.broadcastImmediate(tid, {
        action:         "PLAY_URL",
        commandId:      randomUUID(),
        url,
        title,
        source:         "RADIO",
        snapcastActive: snapOnline,
        // ALL esetén nincs targetDeviceIds → mindenki szól, nincs önmute
        ...(targetIds !== null && { targetDeviceIds: onlineIds }),
      }, onlineIds);
    }

    return res.json({ ok: true, snapcastActive: snapOnline });
  } catch (err) { console.error(err); return res.status(500).json({ error: "Failed to start stream" }); }
});

// POST /messages/stop – Lejátszás leállítása
router.post("/stop", authJwt, requireTenant, async (req: Request, res: Response) => {
  try {
    const tid = tenantId(req);
    await SnapcastService.stop(tid);
    SyncEngine.broadcastImmediate(tid, {
      action:    "STOP_PLAYBACK",
      commandId: randomUUID(),
    });
    console.log(`[MESSAGES] 🛑 Stop → tenant: ${tid}`);
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
    if (user?.role !== "SUPER_ADMIN" && user?.role !== "TENANT_ADMIN") {
      return res.status(403).json({ error: "Forbidden" });
    }
    const message = await prisma.message.findFirst({ where: { id, tenantId: tid }, select: { id: true } });
    if (!message) return res.status(404).json({ error: "Message not found" });
    await prisma.deviceCommand.deleteMany({ where: { messageId: id } });
    await prisma.message.delete({ where: { id } });
    return res.json({ ok: true });
  } catch (err) { console.error(err); return res.status(500).json({ error: "Failed to delete message" }); }
});

export default router;
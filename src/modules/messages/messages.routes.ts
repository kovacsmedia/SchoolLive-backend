import { Router, Request, Response } from "express";
import { prisma } from "../../prisma/client";
import { authJwt } from "../../middleware/authJwt";
import { requireTenant } from "../../middleware/tenant";
import { generateTTS } from "../../services/tts.service";

const router = Router();

// --- Segédfüggvények ---
function tenantId(req: Request): string {
  return (req as any).tenantId as string;
}
function userId(req: Request): string {
  return (req as any).user?.sub as string;
}

// ─────────────────────────────────────────
// GET /messages
// ─────────────────────────────────────────
router.get("/", authJwt, requireTenant, async (req: Request, res: Response) => {
  try {
    const tid = tenantId(req);
    const page  = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(50, parseInt(req.query.limit as string) || 20);
    const skip  = (page - 1) * limit;

    const [messages, total] = await Promise.all([
      prisma.message.findMany({
        where: { tenantId: tid },
        orderBy: { createdAt: "desc" },
        skip,
        take: limit,
        select: {
          id: true,
          title: true,
          text: true,
          type: true,
          voice: true,
          fileUrl: true,
          targetType: true,
          targetId: true,
          scheduledAt: true,
          playedAt: true,
          createdAt: true,
          createdBy: {
            select: { id: true, displayName: true, email: true },
          },
        },
      }),
      prisma.message.count({ where: { tenantId: tid } }),
    ]);

    return res.json({ ok: true, messages, total, page, limit });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Failed to fetch messages" });
  }
});

// ─────────────────────────────────────────
// GET /messages/templates
// ─────────────────────────────────────────
router.get("/templates", authJwt, requireTenant, async (req: Request, res: Response) => {
  try {
    const tid = tenantId(req);
    const uid = userId(req);

    const templates = await prisma.messageTemplate.findMany({
      where:   { tenantId: tid, userId: uid },
      orderBy: { createdAt: "desc" },
      select:  { id: true, name: true, text: true, voice: true, createdAt: true },
    });

    return res.json({ ok: true, templates });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Failed to fetch templates" });
  }
});

// ─────────────────────────────────────────
// POST /messages/templates
// ─────────────────────────────────────────
router.post("/templates", authJwt, requireTenant, async (req: Request, res: Response) => {
  try {
    console.log("[DEBUG] req.user:", JSON.stringify((req as any).user));
    const tid = tenantId(req);
    const uid = userId(req);
    console.log("[DEBUG] uid:", uid);

    const { name, text, voice = "anna" } = req.body;

    if (!name || !text) {
      return res.status(400).json({ error: "name and text are required" });
    }

     const template = await prisma.messageTemplate.create({
      data: {
        name,
        text,
        voice,
        tenant: { connect: { id: tid } },
        user:   { connect: { id: uid } },
     },
});

    return res.status(201).json({ ok: true, template });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Failed to save template" });
  }
});

// ─────────────────────────────────────────
// DELETE /messages/templates/:id
// ─────────────────────────────────────────
router.delete("/templates/:id", authJwt, requireTenant, async (req: Request, res: Response) => {
  try {
    const tid = tenantId(req);
    const uid = userId(req);
    const id  = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

    const template = await prisma.messageTemplate.findFirst({
      where: { id, tenantId: tid, userId: uid },
    });

    if (!template) return res.status(404).json({ error: "Template not found" });

    await prisma.messageTemplate.delete({ where: { id } });

    return res.json({ ok: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Failed to delete template" });
  }
});

// ─────────────────────────────────────────
// POST /messages
// ─────────────────────────────────────────
router.post("/", authJwt, requireTenant, async (req: Request, res: Response) => {
  try {
    const tid = tenantId(req);
    const uid = userId(req);

    const { text, voice = "anna", targetType, targetId, scheduledAt } = req.body;

    if (!text || text.trim().length === 0) {
      return res.status(400).json({ error: "Text is required" });
    }
    if (!targetType) {
      return res.status(400).json({ error: "targetType is required" });
    }

    const filename = await generateTTS(text.trim(), voice);
    const fileUrl  = `${process.env.BASE_URL ?? "https://api.schoollive.hu"}/audio/${filename}`;

    const message = await prisma.message.create({
      data: {
        tenantId:    tid,
        createdById: uid,
        type:        "TTS",
        title:       text.trim().substring(0, 64),
        text:        text.trim(),
        voice,
        fileUrl,
        targetType,
        targetId:    targetId ?? null,
        scheduledAt: scheduledAt ? new Date(scheduledAt) : null,
      },
    });

    const deviceIds = await resolveDeviceIds(tid, targetType, targetId);
    const scheduledTime = scheduledAt ? new Date(scheduledAt) : null;

    if (deviceIds.length > 0) {
      await prisma.deviceCommand.createMany({
        data: deviceIds.map((deviceId) => ({
          tenantId:  tid,
          deviceId,
          messageId: message.id,
          status:    "QUEUED",
          payload: {
            action:      "PLAY_URL",
            url:         fileUrl,
            scheduledAt: scheduledTime?.toISOString() ?? null,
          },
        })),
      });
    }

    return res.status(201).json({ ok: true, message });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Failed to create message" });
  }
});

// ─────────────────────────────────────────
// GET /messages/:id
// ─────────────────────────────────────────
router.get("/:id", authJwt, requireTenant, async (req: Request, res: Response) => {
  try {
    const tid = tenantId(req);
    const id  = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

    const message = await prisma.message.findFirst({
      where: { id, tenantId: tid },
      include: {
        createdBy: { select: { id: true, displayName: true, email: true } },
        commands:  { select: { id: true, deviceId: true, status: true, queuedAt: true, ackedAt: true } },
      },
    });

    if (!message) return res.status(404).json({ error: "Message not found" });

    return res.json({ ok: true, message });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Failed to fetch message" });
  }
});

// ─────────────────────────────────────────
// DELETE /messages/:id
// Csak SUPER_ADMIN és TENANT_ADMIN törölhet.
// ─────────────────────────────────────────
router.delete("/:id", authJwt, requireTenant, async (req: Request, res: Response) => {
  try {
    const tid  = tenantId(req);
    const user = (req as any).user;
    const id   = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

    if (user?.role !== "SUPER_ADMIN" && user?.role !== "TENANT_ADMIN") {
      return res.status(403).json({ error: "Forbidden" });
    }

    const message = await prisma.message.findFirst({
      where: { id, tenantId: tid },
      select: { id: true },
    });

    if (!message) {
      return res.status(404).json({ error: "Message not found" });
    }

    // A kapcsolódó DeviceCommand-ok CASCADE-del törlődnek (schema: onDelete: Cascade nincs,
    // ezért explicit töröljük előbb hogy ne legyen FK constraint hiba)
    await prisma.deviceCommand.deleteMany({ where: { messageId: id } });
    await prisma.message.delete({ where: { id } });

    return res.json({ ok: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Failed to delete message" });
  }
});

// ─────────────────────────────────────────
// Segédfüggvény: eszköz ID-k feloldása
// ─────────────────────────────────────────
async function resolveDeviceIds(
  tid: string,
  targetType: string,
  targetId?: string
): Promise<string[]> {
  if (targetType === "ALL") {
    const devices = await prisma.device.findMany({
      where:  { tenantId: tid, online: true },
      select: { id: true },
    });
    return devices.map((d) => d.id);
  }

  if (targetType === "DEVICE" && targetId) {
    return [targetId];
  }

  if (targetType === "GROUP" && targetId) {
    const members = await prisma.deviceGroupMember.findMany({
      where:  { groupId: targetId },
      select: { deviceId: true },
    });
    return members.map((m) => m.deviceId);
  }

  if (targetType === "ORG_UNIT" && targetId) {
    const devices = await prisma.device.findMany({
      where:  { tenantId: tid, orgUnitId: targetId, online: true },
      select: { id: true },
    });
    return devices.map((d) => d.id);
  }

  return [];
}

export default router;
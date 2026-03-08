// src/modules/radio/radio.routes.ts

import { Router, Request, Response } from "express";
import { prisma } from "../../prisma/client";
import { authJwt } from "../../middleware/authJwt";
import { requireTenant } from "../../middleware/tenant";
import multer from "multer";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import * as mm from "music-metadata";

const router = Router();

// ─── Upload könyvtár ───────────────────────────────────────────────────────
const RADIO_UPLOAD_DIR = path.join(process.cwd(), "uploads", "radio");
if (!fs.existsSync(RADIO_UPLOAD_DIR)) {
  fs.mkdirSync(RADIO_UPLOAD_DIR, { recursive: true });
}

// ─── Multer konfig ─────────────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, RADIO_UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const ext  = path.extname(file.originalname).toLowerCase() || ".mp3";
    const hash = crypto.randomBytes(12).toString("hex");
    cb(null, `radio_${hash}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 200 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = [".mp3", ".wav", ".ogg", ".m4a", ".aac"];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext) || file.mimetype.startsWith("audio/")) {
      cb(null, true);
    } else {
      cb(new Error("Only audio files are allowed"));
    }
  },
});

// ─── Segédfüggvények ───────────────────────────────────────────────────────
function tid(req: Request): string {
  return (req as any).tenantId as string;
}
function uid(req: Request): string {
  return (req as any).user?.sub as string;
}
function role(req: Request): string {
  return (req as any).user?.role ?? "";
}
function canWrite(r: string): boolean {
  return ["SUPER_ADMIN", "TENANT_ADMIN", "ORG_ADMIN"].includes(r);
}
function baseUrl(): string {
  return process.env.BASE_URL ?? "https://api.schoollive.hu";
}
function paramId(req: Request): string {
  return String(req.params.id);
}

async function getAudioDurationSec(filePath: string): Promise<number | null> {
  try {
    const meta = await mm.parseFile(filePath, { duration: true });
    const dur  = meta.format.duration;
    return typeof dur === "number" && isFinite(dur) ? Math.round(dur) : null;
  } catch {
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// FÁJLKEZELÉS
// ═══════════════════════════════════════════════════════════════════════════

// GET /radio/files
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

    const result = files.map(f => ({
      ...f,
      _count: { schedules: f.schedules.length },
      schedules: undefined,
    }));

    return res.json({ ok: true, files: result });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Failed to fetch radio files" });
  }
});

// POST /radio/files  (multipart upload)
router.post(
  "/files",
  authJwt,
  requireTenant,
  upload.single("file"),
  async (req: Request, res: Response) => {
    try {
      if (!canWrite(role(req))) {
        if (req.file) fs.unlinkSync(req.file.path);
        return res.status(403).json({ error: "Forbidden" });
      }
      if (!req.file) return res.status(400).json({ error: "No file uploaded" });

      const durationSec = await getAudioDurationSec(req.file.path);
      const fileUrl     = `${baseUrl()}/uploads/radio/${req.file.filename}`;

      const radioFile = await prisma.radioFile.create({
        data: {
          tenantId:    tid(req),
          createdById: uid(req),
          filename:    req.file.filename,
          originalName: req.file.originalname,
          sizeBytes:   req.file.size,
          durationSec,
          fileUrl,
        },
        include: {
          createdBy: { select: { id: true, displayName: true, email: true } },
        },
      });

      return res.status(201).json({ ok: true, file: { ...radioFile, _count: { schedules: 0 } } });
    } catch (err: any) {
      if (req.file) { try { fs.unlinkSync(req.file.path); } catch {} }
      if (err?.code === "P2002") return res.status(409).json({ error: "File already exists" });
      console.error(err);
      return res.status(500).json({ error: "Upload failed" });
    }
  }
);

// DELETE /radio/files/:id
router.delete("/files/:id", authJwt, requireTenant, async (req: Request, res: Response) => {
  try {
    if (!canWrite(role(req))) return res.status(403).json({ error: "Forbidden" });

    const id   = paramId(req);
    const file = await prisma.radioFile.findFirst({ where: { id, tenantId: tid(req) } });
    if (!file) return res.status(404).json({ error: "File not found" });

    const schedCount = await prisma.radioSchedule.count({ where: { radioFileId: id } });

    const filePath = path.join(RADIO_UPLOAD_DIR, file.filename);
    if (fs.existsSync(filePath)) {
      try { fs.unlinkSync(filePath); } catch (e) {
        console.warn("[RADIO] Could not delete physical file:", e);
      }
    }

    await prisma.radioFile.delete({ where: { id: file.id } });

    return res.json({ ok: true, deletedSchedules: schedCount });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Failed to delete file" });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// ÜTEMEZÉSEK
// ═══════════════════════════════════════════════════════════════════════════

// GET /radio/schedules
router.get("/schedules", authJwt, requireTenant, async (req: Request, res: Response) => {
  try {
    if (!canWrite(role(req))) return res.status(403).json({ error: "Forbidden" });

    const from = req.query.from ? new Date(req.query.from as string) : undefined;
    const to   = req.query.to   ? new Date(req.query.to   as string) : undefined;

    const schedules = await prisma.radioSchedule.findMany({
      where: {
        tenantId: tid(req),
        ...(from || to ? {
          scheduledAt: {
            ...(from ? { gte: from } : {}),
            ...(to   ? { lte: to   } : {}),
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
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Failed to fetch schedules" });
  }
});

// POST /radio/schedules
router.post("/schedules", authJwt, requireTenant, async (req: Request, res: Response) => {
  try {
    if (!canWrite(role(req))) return res.status(403).json({ error: "Forbidden" });

    const { radioFileId, targetType, targetId, scheduledAt } = req.body ?? {};
    if (!radioFileId || !targetType || !scheduledAt) {
      return res.status(400).json({ error: "radioFileId, targetType and scheduledAt are required" });
    }

    const scheduledDate = new Date(scheduledAt);
    if (isNaN(scheduledDate.getTime())) return res.status(400).json({ error: "Invalid scheduledAt date" });
    if (scheduledDate < new Date())     return res.status(400).json({ error: "scheduledAt must be in the future" });

    const file = await prisma.radioFile.findFirst({
      where: { id: String(radioFileId), tenantId: tid(req) },
      select: { id: true, durationSec: true },
    });
    if (!file) return res.status(404).json({ error: "Radio file not found" });

    // Ütközésdetekció
    if (file.durationSec) {
      const endTime = new Date(scheduledDate.getTime() + file.durationSec * 1000);
      const conflict = await prisma.radioSchedule.findFirst({
        where: {
          tenantId: tid(req),
          status: "PENDING",
          targetType: targetType as any,
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
              id:           conflict.id,
              scheduledAt:  conflict.scheduledAt,
              originalName: conflict.radioFile.originalName,
            },
          });
        }
      }
    }

    const schedule = await prisma.radioSchedule.create({
      data: {
        tenantId:    tid(req),
        createdById: uid(req),
        radioFileId: file.id,
        targetType:  targetType as any,
        targetId:    targetId ? String(targetId) : null,
        scheduledAt: scheduledDate,
        status:      "PENDING",
      },
      include: {
        radioFile: { select: { id: true, originalName: true, durationSec: true, fileUrl: true } },
      },
    });

    return res.status(201).json({ ok: true, schedule });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Failed to create schedule" });
  }
});

// PATCH /radio/schedules/:id
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

    const updated = await prisma.radioSchedule.update({
      where: { id: existing.id },
      data,
      include: {
        radioFile: { select: { id: true, originalName: true, durationSec: true, fileUrl: true } },
      },
    });

    return res.json({ ok: true, schedule: updated });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Failed to update schedule" });
  }
});

// DELETE /radio/schedules/:id
router.delete("/schedules/:id", authJwt, requireTenant, async (req: Request, res: Response) => {
  try {
    if (!canWrite(role(req))) return res.status(403).json({ error: "Forbidden" });

    const id       = paramId(req);
    const existing = await prisma.radioSchedule.findFirst({ where: { id, tenantId: tid(req) } });
    if (!existing) return res.status(404).json({ error: "Schedule not found" });

    await prisma.radioSchedule.delete({ where: { id: existing.id } });
    return res.json({ ok: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Failed to delete schedule" });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// ESZKÖZÖK ÉS CSOPORTOK (célválasztóhoz)
// ═══════════════════════════════════════════════════════════════════════════

router.get("/targets", authJwt, requireTenant, async (req: Request, res: Response) => {
  try {
    if (!canWrite(role(req))) return res.status(403).json({ error: "Forbidden" });

    const [devices, groups] = await Promise.all([
      prisma.device.findMany({
        where:   { tenantId: tid(req) },
        select:  { id: true, name: true, online: true, deviceClass: true },
        orderBy: { name: "asc" },
      }),
      prisma.deviceGroup.findMany({
        where:   { tenantId: tid(req) },
        select:  { id: true, name: true },
        orderBy: { name: "asc" },
      }),
    ]);

    return res.json({ ok: true, devices, groups });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Failed to fetch targets" });
  }
});

export default router;
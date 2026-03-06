import { Router, Request, Response, NextFunction } from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import axios from "axios";
import { prisma } from "../../prisma";
import { authJwt } from "../../middleware/authJwt";

export const bellsRouter = Router();

const AUDIO_DIR = path.join(process.cwd(), "audio", "bells");
const MAX_TOTAL_BYTES = 500 * 1024;
const DEFAULT_SOUNDS = ["jelzocsengo.mp3", "kibecsengo.mp3"];

if (!fs.existsSync(AUDIO_DIR)) fs.mkdirSync(AUDIO_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req: Express.Request, _file: Express.Multer.File, cb: (err: Error | null, dest: string) => void) => cb(null, AUDIO_DIR),
  filename: (_req: Express.Request, file: Express.Multer.File, cb: (err: Error | null, name: string) => void) => cb(null, file.originalname),
});

const upload = multer({
  storage,
  fileFilter: (_req: Express.Request, file: Express.Multer.File, cb: multer.FileFilterCallback) => {
    if (file.mimetype === "audio/mpeg" || file.originalname.endsWith(".mp3")) {
      cb(null, true);
    } else {
      cb(new Error("Only MP3 files allowed"));
    }
  },
});

function tid(req: Request): string { return (req as any).user?.tenantId as string; }
function uid(req: Request): string { return (req as any).user?.sub as string; }
function role(req: Request): string { return (req as any).user?.role as string; }

const ORG_ADMIN_ROLES = ["ORG_ADMIN", "TENANT_ADMIN", "SUPER_ADMIN"];

function canEdit(req: Request, res: Response, next: NextFunction) {
  if (!ORG_ADMIN_ROLES.includes(role(req))) {
    return res.status(403).json({ error: "Insufficient permissions" });
  }
  next();
}

// ─── Sablonok ──────────────────────────────────────────────────────────────

bellsRouter.get("/templates", authJwt, canEdit, async (req: Request, res: Response) => {
  const templates = await prisma.bellScheduleTemplate.findMany({
    where: { tenantId: tid(req) },
    include: { bells: { orderBy: [{ hour: "asc" }, { minute: "asc" }] } },
    orderBy: { createdAt: "asc" },
  });
  res.json({ ok: true, templates });
});

bellsRouter.post("/templates", authJwt, canEdit, async (req: Request, res: Response) => {
  const { name, bells } = req.body;
  if (!name || !Array.isArray(bells)) {
    return res.status(400).json({ error: "name and bells required" });
  }
  const count = await prisma.bellScheduleTemplate.count({ where: { tenantId: tid(req) } });
  if (count >= 6) return res.status(400).json({ error: "Maximum 6 templates allowed" });

  const template = await prisma.bellScheduleTemplate.create({
    data: {
      tenantId: tid(req),
      name,
      isDefault: false,
      isLocked: false,
      bells: {
        create: bells.map((b: any) => ({
          hour: b.hour,
          minute: b.minute,
          type: b.type,
          soundFile: b.soundFile || (b.type === "SIGNAL" ? "jelzocsengo.mp3" : "kibecsengo.mp3"),
        })),
      },
    },
    include: { bells: true },
  });
  res.status(201).json({ ok: true, template });
});

bellsRouter.put("/templates/:id", authJwt, canEdit, async (req: Request, res: Response) => {
  const { name, bells } = req.body;
  const template = await prisma.bellScheduleTemplate.findFirst({
    where: { id: req.params.id, tenantId: tid(req) },
  });
  if (!template) return res.status(404).json({ error: "Not found" });
  if (template.isLocked) return res.status(403).json({ error: "Cannot modify locked template" });

  await prisma.bellEntry.deleteMany({ where: { templateId: template.id } });
  const updated = await prisma.bellScheduleTemplate.update({
    where: { id: template.id },
    data: {
      name,
      bells: {
        create: bells.map((b: any) => ({
          hour: b.hour,
          minute: b.minute,
          type: b.type,
          soundFile: b.soundFile || (b.type === "SIGNAL" ? "jelzocsengo.mp3" : "kibecsengo.mp3"),
        })),
      },
    },
    include: { bells: true },
  });
  res.json({ ok: true, template: updated });
});

bellsRouter.delete("/templates/:id", authJwt, canEdit, async (req: Request, res: Response) => {
  const template = await prisma.bellScheduleTemplate.findFirst({
    where: { id: req.params.id, tenantId: tid(req) },
  });
  if (!template) return res.status(404).json({ error: "Not found" });
  if (template.isLocked) return res.status(403).json({ error: "Cannot delete locked template" });

  await prisma.bellScheduleTemplate.delete({ where: { id: template.id } });
  res.json({ ok: true });
});

// ─── Naptár ────────────────────────────────────────────────────────────────

bellsRouter.get("/calendar", authJwt, canEdit, async (req: Request, res: Response) => {
  const year = parseInt(req.query.year as string) || new Date().getFullYear();
  const from = new Date(`${year}-01-01`);
  const to = new Date(`${year}-12-31`);

  const days = await prisma.bellCalendarDay.findMany({
    where: { tenantId: tid(req), date: { gte: from, lte: to } },
    include: { template: { include: { bells: true } } },
    orderBy: { date: "asc" },
  });
  res.json({ ok: true, days });
});

bellsRouter.post("/calendar/init", authJwt, canEdit, async (req: Request, res: Response) => {
  const year = parseInt(req.body.year) || new Date().getFullYear();
  try {
    const resp = await axios.get(`https://szunetnapok.hu/api/?year=${year}&country=hu`);
    const holidays: string[] = resp.data?.holidays || [];

    const weekends: string[] = [];
    const d = new Date(`${year}-01-01`);
    while (d.getFullYear() === year) {
      if (d.getDay() === 0 || d.getDay() === 6) {
        weekends.push(d.toISOString().split("T")[0]);
      }
      d.setDate(d.getDate() + 1);
    }

    const allHolidays = [...new Set([...holidays, ...weekends])];
    for (const dateStr of allHolidays) {
      await prisma.bellCalendarDay.upsert({
        where: { tenantId_date: { tenantId: tid(req), date: new Date(dateStr) } },
        update: { isHoliday: true },
        create: { tenantId: tid(req), date: new Date(dateStr), isHoliday: true },
      });
    }
    res.json({ ok: true, imported: allHolidays.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch holidays" });
  }
});

bellsRouter.put("/calendar/:date", authJwt, canEdit, async (req: Request, res: Response) => {
  const { isHoliday, templateId } = req.body;
  const date = new Date(req.params.date);

  const day = await prisma.bellCalendarDay.upsert({
    where: { tenantId_date: { tenantId: tid(req), date } },
    update: { isHoliday: isHoliday ?? false, templateId: templateId ?? null },
    create: { tenantId: tid(req), date, isHoliday: isHoliday ?? false, templateId: templateId ?? null },
    include: { template: true },
  });
  res.json({ ok: true, day });
});

// ─── Hangfájlok ────────────────────────────────────────────────────────────

bellsRouter.get("/sounds", authJwt, canEdit, async (req: Request, res: Response) => {
  const sounds = await prisma.bellSoundFile.findMany({
    where: { tenantId: tid(req) },
    orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
  });
  res.json({ ok: true, sounds });
});

bellsRouter.post("/sounds", authJwt, canEdit, upload.single("file"), async (req: Request, res: Response) => {
  const file = (req as any).file as Express.Multer.File | undefined;
  if (!file) return res.status(400).json({ error: "No file uploaded" });

  const existing = await prisma.bellSoundFile.findMany({ where: { tenantId: tid(req) } });
  const totalUsed = existing.reduce((sum: number, s: any) => sum + s.sizeBytes, 0);
  const available = MAX_TOTAL_BYTES - totalUsed;

  if (file.size > available) {
    fs.unlinkSync(file.path);
    return res.status(400).json({
      error: `Not enough space. Available: ${Math.floor(available / 1024)}KB, needed: ${Math.floor(file.size / 1024)}KB`,
    });
  }

  const sound = await prisma.bellSoundFile.upsert({
    where: { tenantId_filename: { tenantId: tid(req), filename: file.originalname } },
    update: { sizeBytes: file.size },
    create: {
      tenantId: tid(req),
      filename: file.originalname,
      sizeBytes: file.size,
      isDefault: DEFAULT_SOUNDS.includes(file.originalname),
    },
  });
  res.status(201).json({ ok: true, sound });
});

bellsRouter.delete("/sounds/:id", authJwt, canEdit, async (req: Request, res: Response) => {
  const sound = await prisma.bellSoundFile.findFirst({
    where: { id: req.params.id, tenantId: tid(req) },
  });
  if (!sound) return res.status(404).json({ error: "Not found" });
  if (sound.isDefault) return res.status(403).json({ error: "Cannot delete default sound" });

  const filePath = path.join(AUDIO_DIR, sound.filename);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

  await prisma.bellSoundFile.delete({ where: { id: sound.id } });
  res.json({ ok: true });
});

// ─── Szerkesztési zár ──────────────────────────────────────────────────────

bellsRouter.post("/lock", authJwt, canEdit, async (req: Request, res: Response) => {
  const existing = await prisma.bellScheduleLock.findUnique({ where: { tenantId: tid(req) } });
  if (existing && existing.userId !== uid(req)) {
    const age = Date.now() - existing.lockedAt.getTime();
    if (age < 30 * 60 * 1000) {
      return res.status(409).json({ error: "Locked by another user", lockedAt: existing.lockedAt });
    }
  }

  const lock = await prisma.bellScheduleLock.upsert({
    where: { tenantId: tid(req) },
    update: { userId: uid(req), lockedAt: new Date() },
    create: { tenantId: tid(req), userId: uid(req) },
  });
  res.json({ ok: true, lock });
});

bellsRouter.delete("/lock", authJwt, canEdit, async (req: Request, res: Response) => {
  await prisma.bellScheduleLock.deleteMany({
    where: { tenantId: tid(req), userId: uid(req) },
  });
  res.json({ ok: true });
});

// ─── Szinkronizáció eszköznek ──────────────────────────────────────────────

bellsRouter.get("/sync", async (req: Request, res: Response) => {
  const deviceKey = req.headers["x-device-key"] as string;
  if (!deviceKey) return res.status(401).json({ error: "Missing device key" });

  const bcrypt = await import("bcrypt");
  const devices = await prisma.device.findMany({ where: { authType: "KEY" } });
  let device: any = null;
  for (const d of devices) {
    if (d.deviceKeyHash && await bcrypt.compare(deviceKey, d.deviceKeyHash)) {
      device = d; break;
    }
  }
  if (!device) return res.status(401).json({ error: "Invalid device key" });

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const calDay = await prisma.bellCalendarDay.findUnique({
    where: { tenantId_date: { tenantId: device.tenantId, date: today } },
    include: { template: { include: { bells: { orderBy: [{ hour: "asc" }, { minute: "asc" }] } } } },
  });

  const defaultTemplate = await prisma.bellScheduleTemplate.findFirst({
    where: { tenantId: device.tenantId, isDefault: true, name: "Normál csengetési rend" },
    include: { bells: { orderBy: [{ hour: "asc" }, { minute: "asc" }] } },
  });

  let bells: any[] = [];
  let isHoliday = false;

  if (calDay?.isHoliday) {
    isHoliday = true;
    bells = [];
  } else if (calDay?.template) {
    bells = calDay.template.bells;
  } else {
    bells = defaultTemplate?.bells || [];
  }

  const sounds = await prisma.bellSoundFile.findMany({ where: { tenantId: device.tenantId } });

  res.json({
    ok: true,
    isHoliday,
    bells: bells.map((b: any) => ({ hour: b.hour, minute: b.minute, type: b.type, soundFile: b.soundFile })),
    sounds: sounds.map((s: any) => ({
      filename: s.filename,
      url: `/audio/bells/${s.filename}`,
      sizeBytes: s.sizeBytes,
    })),
    updatedAt: new Date().toISOString(),
  });
});
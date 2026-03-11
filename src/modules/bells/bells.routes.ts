import { Router, Request, Response, NextFunction } from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import axios from "axios";
import prisma from "../../prisma";
import { authJwt } from "../../middleware/authJwt";

export const bellsRouter = Router();

/** UTC-éjféli Date objektum az aktuális helyi (Europe/Budapest) naptári napra */
function todayInBudapest(): Date {
  const now = new Date();
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Budapest",
    year: "numeric", month: "2-digit", day: "2-digit"
  });
  const [year, month, day] = fmt.format(now).split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

const AUDIO_DIR = path.join(process.cwd(), "audio", "bells");
const MAX_TOTAL_BYTES = 500 * 1024;
const DEFAULT_SOUNDS = ["jelzocsengo.mp3", "kibecsengo.mp3"];

if (!fs.existsSync(AUDIO_DIR)) fs.mkdirSync(AUDIO_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, AUDIO_DIR),
  filename: (_req, file, cb) => cb(null, file.originalname),
});

const upload = multer({
  storage,
  fileFilter: (_req, file, cb) => {
    if (file.mimetype === "audio/mpeg" || file.originalname.endsWith(".mp3")) {
      cb(null, true);
    } else {
      cb(new Error("Only MP3 files allowed"));
    }
  },
});

function tid(req: Request): string {
  const fromHeader = req.headers["x-tenant-id"] as string;
  if (fromHeader) return fromHeader;
  return (req as any).user?.tenantId as string;
}
function uid(req: Request): string { return (req as any).user?.sub as string; }
function userRole(req: Request): string { return (req as any).user?.role as string; }

const ORG_ADMIN_ROLES = ["ORG_ADMIN", "TENANT_ADMIN", "SUPER_ADMIN"];

function canEdit(req: Request, res: Response, next: NextFunction) {
  if (!ORG_ADMIN_ROLES.includes(userRole(req))) {
    return res.status(403).json({ error: "Insufficient permissions" });
  }
  next();
}

function makeVersion(scope: string, bells: any[]): string {
  const raw = `${scope}:${bells.map(b => `${b.hour}:${b.minute}:${b.type}:${b.soundFile}`).join(",")}`;
  return crypto.createHash("md5").update(raw).digest("hex").slice(0, 12);
}

async function authenticateDevice(req: Request): Promise<any | null> {
  const deviceKey = req.headers["x-device-key"] as string;
  if (!deviceKey) return null;

  const bcrypt = await import("bcrypt");
  const devices = await prisma.device.findMany({ where: { authType: "KEY" } });
  for (const d of devices) {
    if (d.deviceKeyHash && await bcrypt.compare(deviceKey, d.deviceKeyHash)) {
      return d;
    }
  }
  return null;
}

async function resolveTodayBells(tenantId: string, today: Date): Promise<{
  bells: any[];
  defaultBells: any[];
  isHoliday: boolean;
  todayVersion: string;
  defaultVersion: string;
}> {
  const dateStr = today.toISOString().split("T")[0];

  const calDay = await prisma.bellCalendarDay.findUnique({
    where: { tenantId_date: { tenantId, date: today } },
    include: { template: { include: { bells: { orderBy: [{ hour: "asc" }, { minute: "asc" }] } } } },
  });

  const defaultTemplate = await prisma.bellScheduleTemplate.findFirst({
    where: { tenantId, isDefault: true },
    include: { bells: { orderBy: [{ hour: "asc" }, { minute: "asc" }] } },
  });

  const defaultBells = defaultTemplate?.bells ?? [];
  const defaultVersion = makeVersion("default", defaultBells);

  let bells: any[] = [];
  let isHoliday = false;

  if (calDay?.isHoliday) {
    isHoliday = true;
  } else if (calDay?.template) {
    bells = calDay.template.bells;
  } else {
    bells = defaultBells;
  }

  const todayVersion = isHoliday
    ? `holiday:${dateStr}`
    : makeVersion(dateStr, bells);

  return { bells, defaultBells, isHoliday, todayVersion, defaultVersion };
}

// ─── SYNC_BELLS dispatch helper ────────────────────────────────────────────
// Minden VP eszközre (authType: JWT) küld egy SYNC_BELLS parancsot,
// hogy azonnal szinkronizálják a csengetési rendet.
async function dispatchSyncBellsToVP(tenantId: string): Promise<void> {
  try {
    const vpDevices = await prisma.device.findMany({
      where: { tenantId, authType: "JWT" },
      select: { id: true },
    });
    if (vpDevices.length === 0) return;

    await prisma.deviceCommand.createMany({
      data: vpDevices.map(d => ({
        tenantId,
        deviceId: d.id,
        status: "QUEUED",
        payload: { action: "SYNC_BELLS" },
      })),
    });
    console.log(`[BELLS] SYNC_BELLS dispatched to ${vpDevices.length} VP device(s) in tenant ${tenantId}`);
  } catch (e) {
    console.error("[BELLS] dispatchSyncBellsToVP error:", e);
  }
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

  // VP eszközök értesítése
  void dispatchSyncBellsToVP(tid(req));

  res.status(201).json({ ok: true, template });
});

bellsRouter.put("/templates/:id", authJwt, canEdit, async (req: Request, res: Response) => {
  const templateId = req.params.id as string;
  const { name, bells } = req.body;
  const template = await prisma.bellScheduleTemplate.findFirst({
    where: { id: templateId, tenantId: tid(req) },
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

  // VP eszközök értesítése
  void dispatchSyncBellsToVP(tid(req));

  res.json({ ok: true, template: updated });
});

bellsRouter.delete("/templates/:id", authJwt, canEdit, async (req: Request, res: Response) => {
  const templateId = req.params.id as string;
  const template = await prisma.bellScheduleTemplate.findFirst({
    where: { id: templateId, tenantId: tid(req) },
  });
  if (!template) return res.status(404).json({ error: "Not found" });
  if (template.isLocked) return res.status(403).json({ error: "Cannot delete locked template" });

  await prisma.bellScheduleTemplate.delete({ where: { id: template.id } });

  // VP eszközök értesítése
  void dispatchSyncBellsToVP(tid(req));

  res.json({ ok: true });
});

bellsRouter.put("/templates/:id/set-default", authJwt, canEdit, async (req: Request, res: Response) => {
  const templateId = req.params.id as string;

  const template = await prisma.bellScheduleTemplate.findFirst({
    where: { id: templateId, tenantId: tid(req) },
  });
  if (!template) return res.status(404).json({ error: "Not found" });

  await prisma.$transaction([
    prisma.bellScheduleTemplate.updateMany({
      where: { tenantId: tid(req) },
      data: { isDefault: false },
    }),
    prisma.bellScheduleTemplate.update({
      where: { id: templateId },
      data: { isDefault: true },
    }),
  ]);

  const updated = await prisma.bellScheduleTemplate.findUnique({
    where: { id: templateId },
    include: { bells: { orderBy: [{ hour: "asc" }, { minute: "asc" }] } },
  });

  // VP eszközök értesítése
  void dispatchSyncBellsToVP(tid(req));

  res.json({ ok: true, template: updated });
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
  const dateStr = req.params.date as string;
  const date = new Date(dateStr);

  const day = await prisma.bellCalendarDay.upsert({
    where: { tenantId_date: { tenantId: tid(req), date } },
    update: { isHoliday: isHoliday ?? false, templateId: templateId ?? null },
    create: { tenantId: tid(req), date, isHoliday: isHoliday ?? false, templateId: templateId ?? null },
    include: { template: true },
  });

  // VP eszközök értesítése
  void dispatchSyncBellsToVP(tid(req));

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

  // Új hangfájl feltöltésekor is szinkronizáljuk
  void dispatchSyncBellsToVP(tid(req));

  res.status(201).json({ ok: true, sound });
});

bellsRouter.delete("/sounds/:id", authJwt, canEdit, async (req: Request, res: Response) => {
  const soundId = req.params.id as string;
  const sound = await prisma.bellSoundFile.findFirst({
    where: { id: soundId, tenantId: tid(req) },
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

// ─── Verzió lekérdezés ─────────────────────────────────────────────────────

bellsRouter.get("/version", async (req: Request, res: Response) => {
  const device = await authenticateDevice(req);
  if (!device) return res.status(401).json({ error: "Invalid or missing device key" });

  const today = todayInBudapest();

  const { isHoliday, todayVersion, defaultVersion } =
    await resolveTodayBells(device.tenantId, today);

  res.json({ ok: true, todayVersion, defaultVersion, isHoliday });
});

// ─── Teljes szinkronizáció eszköznek ──────────────────────────────────────


// ─── /today – JWT-vel is elérhető (VirtualPlayer) ─────────────────────────
bellsRouter.get("/today", authJwt, async (req: Request, res: Response) => {
  const tenantId = tid(req);
  if (!tenantId) return res.status(400).json({ error: "Tenant required" });

  // UTC alapú dátum – a DB is UTC-ben tárolja
  const today = todayInBudapest();

  const { bells, isHoliday } = await resolveTodayBells(tenantId, today);

  return res.json({
    ok: true,
    isHoliday,
    bells: bells.map((b: any) => ({
      hour:      b.hour,
      minute:    b.minute,
      type:      b.type,
      soundFile: b.soundFile,
    })),
  });
});

bellsRouter.get("/sync", async (req: Request, res: Response) => {
  const device = await authenticateDevice(req);
  if (!device) return res.status(401).json({ error: "Invalid or missing device key" });

  const today = todayInBudapest();

  const { bells, defaultBells, isHoliday, todayVersion, defaultVersion } =
    await resolveTodayBells(device.tenantId, today);

  const sounds = await prisma.bellSoundFile.findMany({
    where: { tenantId: device.tenantId },
  });

  res.json({
    ok: true,
    isHoliday,
    todayVersion,
    defaultVersion,
    bells: bells.map((b: any) => ({
      hour:      b.hour,
      minute:    b.minute,
      type:      b.type,
      soundFile: b.soundFile,
    })),
    defaultBells: defaultBells.map((b: any) => ({
      hour:      b.hour,
      minute:    b.minute,
      type:      b.type,
      soundFile: b.soundFile,
    })),
    sounds: sounds.map((s: any) => ({
      filename:  s.filename,
      url:       `/audio/bells/${s.filename}`,
      sizeBytes: s.sizeBytes,
    })),
    updatedAt: new Date().toISOString(),
  });
});
import { Router } from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import { requireAuth, requireRole } from "../../middleware/auth";
import { prisma } from "../../client";
import axios from "axios";

export const bellsRouter = Router();

const AUDIO_DIR = path.join(process.cwd(), "audio", "bells");
const MAX_TOTAL_BYTES = 500 * 1024; // 500KB
const DEFAULT_SOUNDS = ["jelzocsengo.mp3", "kibecsengo.mp3"];

// Mappa létrehozása ha nem létezik
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

function tid(req: any) { return req.user?.tenantId as string; }
function uid(req: any) { return req.user?.sub as string; }

// ─── Jogosultság: ORG_ADMIN+ ───────────────────────────────────────────────
const canEdit = requireRole(["ORG_ADMIN", "TENANT_ADMIN", "SUPER_ADMIN"]);

// ─── Sablonok ──────────────────────────────────────────────────────────────

// GET /bells/templates
bellsRouter.get("/templates", requireAuth, canEdit, async (req, res) => {
  const templates = await prisma.bellScheduleTemplate.findMany({
    where: { tenantId: tid(req) },
    include: { bells: { orderBy: [{ hour: "asc" }, { minute: "asc" }] } },
    orderBy: { createdAt: "asc" },
  });
  res.json({ ok: true, templates });
});

// POST /bells/templates
bellsRouter.post("/templates", requireAuth, canEdit, async (req, res) => {
  const { name, bells } = req.body;
  if (!name || !Array.isArray(bells)) {
    return res.status(400).json({ error: "name and bells required" });
  }

  // Max 6 sablon (2 default + 4 egyéni)
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

// PUT /bells/templates/:id
bellsRouter.put("/templates/:id", requireAuth, canEdit, async (req, res) => {
  const { name, bells } = req.body;
  const template = await prisma.bellScheduleTemplate.findFirst({
    where: { id: req.params.id, tenantId: tid(req) },
  });
  if (!template) return res.status(404).json({ error: "Not found" });
  if (template.isLocked) return res.status(403).json({ error: "Cannot modify locked template" });

  // Töröljük a régi bejegyzéseket, újakat hozunk létre
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

// DELETE /bells/templates/:id
bellsRouter.delete("/templates/:id", requireAuth, canEdit, async (req, res) => {
  const template = await prisma.bellScheduleTemplate.findFirst({
    where: { id: req.params.id, tenantId: tid(req) },
  });
  if (!template) return res.status(404).json({ error: "Not found" });
  if (template.isLocked) return res.status(403).json({ error: "Cannot delete locked template" });

  await prisma.bellScheduleTemplate.delete({ where: { id: template.id } });
  res.json({ ok: true });
});

// ─── Naptár ────────────────────────────────────────────────────────────────

// GET /bells/calendar?year=2026
bellsRouter.get("/calendar", requireAuth, canEdit, async (req, res) => {
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

// POST /bells/calendar/init – munkaszüneti napok betöltése
bellsRouter.post("/calendar/init", requireAuth, canEdit, async (req, res) => {
  const year = parseInt(req.body.year) || new Date().getFullYear();

  try {
    // Ünnepnapok lekérése
    const resp = await axios.get(`https://szunetnapok.hu/api/?year=${year}&country=hu`);
    const holidays: string[] = resp.data?.holidays || [];

    // Hétvégék generálása
    const weekends: string[] = [];
    const d = new Date(`${year}-01-01`);
    while (d.getFullYear() === year) {
      if (d.getDay() === 0 || d.getDay() === 6) {
        weekends.push(d.toISOString().split("T")[0]);
      }
      d.setDate(d.getDate() + 1);
    }

    const allHolidays = [...new Set([...holidays, ...weekends])];

    // Upsert minden ünnepnapot
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

// PUT /bells/calendar/:date – egy nap beállítása
bellsRouter.put("/calendar/:date", requireAuth, canEdit, async (req, res) => {
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

// GET /bells/sounds
bellsRouter.get("/sounds", requireAuth, canEdit, async (req, res) => {
  const sounds = await prisma.bellSoundFile.findMany({
    where: { tenantId: tid(req) },
    orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
  });
  res.json({ ok: true, sounds });
});

// POST /bells/sounds
bellsRouter.post("/sounds", requireAuth, canEdit, upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });

  // Méretkorlát ellenőrzés
  const existing = await prisma.bellSoundFile.findMany({ where: { tenantId: tid(req) } });
  const totalUsed = existing.reduce((sum, s) => sum + s.sizeBytes, 0);
  const available = MAX_TOTAL_BYTES - totalUsed;

  if (req.file.size > available) {
    fs.unlinkSync(req.file.path);
    return res.status(400).json({
      error: `Not enough space. Available: ${Math.floor(available / 1024)}KB, needed: ${Math.floor(req.file.size / 1024)}KB`,
    });
  }

  const sound = await prisma.bellSoundFile.upsert({
    where: { tenantId_filename: { tenantId: tid(req), filename: req.file.originalname } },
    update: { sizeBytes: req.file.size },
    create: {
      tenantId: tid(req),
      filename: req.file.originalname,
      sizeBytes: req.file.size,
      isDefault: DEFAULT_SOUNDS.includes(req.file.originalname),
    },
  });
  res.status(201).json({ ok: true, sound });
});

// DELETE /bells/sounds/:id
bellsRouter.delete("/sounds/:id", requireAuth, canEdit, async (req, res) => {
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

// POST /bells/lock
bellsRouter.post("/lock", requireAuth, canEdit, async (req, res) => {
  const existing = await prisma.bellScheduleLock.findUnique({ where: { tenantId: tid(req) } });
  if (existing && existing.userId !== uid(req)) {
    // Timeout: 30 perc után automatikusan felszabadul
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

// DELETE /bells/lock
bellsRouter.delete("/lock", requireAuth, canEdit, async (req, res) => {
  await prisma.bellScheduleLock.deleteMany({
    where: { tenantId: tid(req), userId: uid(req) },
  });
  res.json({ ok: true });
});

// ─── Szinkronizáció eszköznek ──────────────────────────────────────────────

// GET /bells/sync – eszköz lekéri a napi csengetési rendet
bellsRouter.get("/sync", async (req, res) => {
  // Device auth
  const deviceKey = req.headers["x-device-key"] as string;
  if (!deviceKey) return res.status(401).json({ error: "Missing device key" });

  const bcrypt = await import("bcrypt");
  const devices = await prisma.device.findMany({ where: { authType: "KEY" } });
  let device = null;
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

  // Alapértelmezett (normál) sablon
  const defaultTemplate = await prisma.bellScheduleTemplate.findFirst({
    where: { tenantId: device.tenantId, isDefault: true, name: "Normál csengetési rend" },
    include: { bells: { orderBy: [{ hour: "asc" }, { minute: "asc" }] } },
  });

  let bells = null;
  let isHoliday = false;

  if (calDay?.isHoliday) {
    isHoliday = true;
    bells = [];
  } else if (calDay?.template) {
    bells = calDay.template.bells;
  } else {
    bells = defaultTemplate?.bells || [];
  }

  // Hangfájlok listája
  const sounds = await prisma.bellSoundFile.findMany({ where: { tenantId: device.tenantId } });

  res.json({
    ok: true,
    isHoliday,
    bells: bells.map(b => ({ hour: b.hour, minute: b.minute, type: b.type, soundFile: b.soundFile })),
    sounds: sounds.map(s => ({
      filename: s.filename,
      url: `/audio/bells/${s.filename}`,
      sizeBytes: s.sizeBytes,
    })),
    updatedAt: new Date().toISOString(),
  });
});
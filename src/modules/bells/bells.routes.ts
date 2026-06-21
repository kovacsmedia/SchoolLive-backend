import { Router, Request, Response, NextFunction } from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import axios from "axios";
import { execSync } from "child_process";
import prisma from "../../prisma";
import { authJwt } from "../../middleware/authJwt";
import { broadcastSyncBells } from "./bell.scheduler";
import { stripAccents } from "../../utils/text";

/** ffprobe alapú hossz-mérés ms-ben. Hiba/elérhetetlenség esetén null. */
function probeDurationMs(filePath: string): number | null {
  try {
    const out = execSync(
      `ffprobe -v quiet -show_entries format=duration -of csv=p=0 "${filePath}"`,
      { timeout: 3000 }
    ).toString().trim();
    const sec = parseFloat(out);
    if (isFinite(sec) && sec > 0) return Math.round(sec * 1000);
  } catch {}
  return null;
}

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
// 4 MB tárhely – az ESP32-S3-N16R8 (16MB flash) particionálásában az
// /audio LittleFS partíción kb. ennyi marad a firmware + littlefs +
// updater partíciók mellett.
const MAX_TOTAL_BYTES = 4 * 1024 * 1024;
const DEFAULT_SOUNDS = ["jelzocsengo.mp3", "kibecsengo.mp3"];

if (!fs.existsSync(AUDIO_DIR)) fs.mkdirSync(AUDIO_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, AUDIO_DIR),
  // Ékezetmentes fájlnév – a downstream eszközöknek (ESP / Python kliens /
  // snapclient) így biztosan nem lesz baja a "csengő.mp3" típusú nevekkel.
  filename: (_req, file, cb) => cb(null, stripAccents(file.originalname)),
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

// ── SYNC_BELLS dispatch helper ─────────────────────────────────────────────
// Kétirányú értesítés minden módosításkor:
//   1. broadcastSyncBells   → azonnal WS push az online eszközöknek (ESP32, Android, Python)
//   2. dispatchSyncBellsToVP → DB queue a JWT-alapú offline VP eszközöknek (polling)
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
    console.log(`[BELLS] SYNC_BELLS DB queue → ${vpDevices.length} VP eszköz (tenant: ${tenantId})`);
  } catch (e) {
    console.error("[BELLS] dispatchSyncBellsToVP error:", e);
  }
}

// Mindkét értesítést egyszerre hívja – ezt használjuk minden módosítás után
function notifyAllClients(tenantId: string): void {
  // 1. Azonnali WS push az online eszközöknek
  broadcastSyncBells(tenantId);
  // 2. DB queue az offline/JWT eszközöknek
  void dispatchSyncBellsToVP(tenantId);
}

// ── Sablonok ───────────────────────────────────────────────────────────────

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

  notifyAllClients(tid(req));

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

  notifyAllClients(tid(req));

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

  notifyAllClients(tid(req));

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

  notifyAllClients(tid(req));

  res.json({ ok: true, template: updated });
});

// ── Naptár ─────────────────────────────────────────────────────────────────

bellsRouter.get("/calendar", authJwt, canEdit, async (req: Request, res: Response) => {
  const year = parseInt(req.query.year as string) || new Date().getFullYear();
  const from = new Date(`${year}-01-01`);
  const to   = new Date(`${year}-12-31`);

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
    // CSAK a tényleges munkaszüneti napokat töltjük be (kb. 13 nap):
    // - jan 1 (Újév), márc 15, nagypéntek, húsvét hétfő, máj 1, pünkösd hétfő,
    //   aug 20, okt 23, nov 1, dec 25, 26, stb.
    // A hétvégéket NEM tesszük a DB-be – a frontend a getDay()===0|6 alapján
    // amúgy is pirosan jelöli őket, és nem érdemes ~100 fölösleges rekorddal
    // szennyezni a BellCalendarDay táblát (a "104 szünnap" bug oka eddig az
    // volt, hogy a weekendet is hozzáadtuk).
    const resp = await axios.get(`https://szunetnapok.hu/api/?year=${year}&country=hu`);
    const holidays: string[] = resp.data?.holidays || [];

    let imported = 0;
    for (const dateStr of holidays) {
      // A hétvégi munkaszüneti nap is hétvége – azt is mentjük (pl. ha aug 20
      // szombatra esik, a naptárban legyen explicit "SZÜNNAP" jelölés is, ne
      // csak "HÉTVÉGE").
      await prisma.bellCalendarDay.upsert({
        where:  { tenantId_date: { tenantId: tid(req), date: new Date(dateStr) } },
        update: { isHoliday: true },
        create: { tenantId: tid(req), date: new Date(dateStr), isHoliday: true },
      });
      imported++;
    }

    // Naptár inicializálásakor is értesítjük a klienseket
    notifyAllClients(tid(req));

    res.json({ ok: true, imported });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch holidays" });
  }
});

bellsRouter.put("/calendar/:date", authJwt, canEdit, async (req: Request, res: Response) => {
  const { isHoliday, templateId, note } = req.body;
  const dateStr = req.params.date as string;
  const date    = new Date(dateStr);

  // Note: 16 karakter max, ékezetek megengedettek (a naptár-megjegyzés
  // megjelenítő stringnél nem szabunk fájlnév-szerű korlátot). Az üres
  // / null érték eltávolítja a megjegyzést.
  let cleanNote: string | null = null;
  if (typeof note === "string") {
    const t = note.trim();
    if (t.length > 0) cleanNote = t.slice(0, 16);
  }

  const day = await prisma.bellCalendarDay.upsert({
    where: { tenantId_date: { tenantId: tid(req), date } },
    update: {
      isHoliday:  isHoliday ?? false,
      templateId: templateId ?? null,
      note:       cleanNote,
    },
    create: {
      tenantId: tid(req), date,
      isHoliday:  isHoliday ?? false,
      templateId: templateId ?? null,
      note:       cleanNote,
    },
    include: { template: true },
  });

  notifyAllClients(tid(req));

  res.json({ ok: true, day });
});

// ── Hangfájlok ────────────────────────────────────────────────────────────

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

  const existing  = await prisma.bellSoundFile.findMany({ where: { tenantId: tid(req) } });
  const totalUsed = existing.reduce((sum: number, s: any) => sum + s.sizeBytes, 0);
  const available = MAX_TOTAL_BYTES - totalUsed;

  if (file.size > available) {
    fs.unlinkSync(file.path);
    return res.status(400).json({
      error: `Not enough space. Available: ${Math.floor(available / 1024)}KB, needed: ${Math.floor(file.size / 1024)}KB`,
    });
  }

  // A multer `filename` setter már ékezet-mentesítette → ugyanazt használjuk
  // a DB-ben, hogy a lookup egyezzen a fájlrendszerrel.
  const cleanName = stripAccents(file.originalname);
  const sound = await prisma.bellSoundFile.upsert({
    where: { tenantId_filename: { tenantId: tid(req), filename: cleanName } },
    update: { sizeBytes: file.size },
    create: {
      tenantId:  tid(req),
      filename:  cleanName,
      sizeBytes: file.size,
      isDefault: DEFAULT_SOUNDS.includes(cleanName),
    },
  });

  notifyAllClients(tid(req));

  res.status(201).json({ ok: true, sound });
});

bellsRouter.delete("/sounds/:id", authJwt, canEdit, async (req: Request, res: Response) => {
  const soundId = req.params.id as string;
  const sound   = await prisma.bellSoundFile.findFirst({
    where: { id: soundId, tenantId: tid(req) },
  });
  if (!sound) return res.status(404).json({ error: "Not found" });
  if (sound.isDefault) return res.status(403).json({ error: "Cannot delete default sound" });

  const filePath = path.join(AUDIO_DIR, sound.filename);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

  await prisma.bellSoundFile.delete({ where: { id: sound.id } });

  // Hangfájl törlésekor is értesítjük – a kliensek így tudnak takarítani a cache-ből
  notifyAllClients(tid(req));

  res.json({ ok: true });
});

// ── Üzenet-intro hangok (max 7s, dingdong helyettesítő) ────────────────────
// Külön audio-dir hogy a csengetési rend (SCHEDULE) hangok ne keveredjenek.

const INTRO_AUDIO_DIR    = path.join(process.cwd(), "audio", "intros");
const INTRO_MAX_DURATION_MS = 7_000;   // 7 mp – user kérés szerint
const INTRO_MAX_BYTES       = 200 * 1024; // 200KB – elég 7s mp3-hoz
if (!fs.existsSync(INTRO_AUDIO_DIR)) fs.mkdirSync(INTRO_AUDIO_DIR, { recursive: true });

const introStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, INTRO_AUDIO_DIR),
  filename:    (_req, file, cb) => {
    // Egyedi prefix-szel, hogy a több tenant ne ütközzön azonos eredeti névnél.
    // Először ékezet-mentesítés, aztán nem alfanumerikus karakter-szűrés.
    const safe = stripAccents(file.originalname).replace(/[^a-zA-Z0-9._-]/g, "_");
    cb(null, `${Date.now()}_${safe}`);
  },
});
const introUpload = multer({
  storage: introStorage,
  limits:  { fileSize: INTRO_MAX_BYTES },
  fileFilter: (_req, file, cb) => {
    // MP3, WAV, OGG audio elfogadva
    if (file.mimetype.startsWith("audio/")) cb(null, true);
    else cb(new Error("Only audio files allowed"));
  },
});

bellsRouter.get("/intro-sounds", authJwt, canEdit, async (req: Request, res: Response) => {
  const sounds = await prisma.bellSoundFile.findMany({
    where:   { tenantId: tid(req), kind: "MESSAGE_INTRO" },
    orderBy: [{ createdAt: "asc" }],
  });
  res.json({ ok: true, sounds });
});

bellsRouter.post("/intro-sounds", authJwt, canEdit, introUpload.single("file"), async (req: Request, res: Response) => {
  const file = (req as any).file as Express.Multer.File | undefined;
  if (!file) return res.status(400).json({ error: "No file uploaded" });

  // ffprobe duration check – max 7s
  const durationMs = probeDurationMs(file.path);
  if (durationMs === null) {
    try { fs.unlinkSync(file.path); } catch {}
    return res.status(400).json({ error: "Cannot read audio duration" });
  }
  if (durationMs > INTRO_MAX_DURATION_MS) {
    try { fs.unlinkSync(file.path); } catch {}
    return res.status(400).json({
      error: `Túl hosszú: ${(durationMs/1000).toFixed(1)}s, max ${INTRO_MAX_DURATION_MS/1000}s engedélyezett.`,
    });
  }

  const sound = await prisma.bellSoundFile.create({
    data: {
      tenantId:   tid(req),
      filename:   file.filename,
      sizeBytes:  file.size,
      isDefault:  false,
      kind:       "MESSAGE_INTRO",
      durationMs,
    },
  });

  res.status(201).json({ ok: true, sound });
});

bellsRouter.delete("/intro-sounds/:id", authJwt, canEdit, async (req: Request, res: Response) => {
  const soundId = req.params.id as string;
  const sound   = await prisma.bellSoundFile.findFirst({
    where: { id: soundId, tenantId: tid(req), kind: "MESSAGE_INTRO" },
  });
  if (!sound) return res.status(404).json({ error: "Not found" });

  const filePath = path.join(INTRO_AUDIO_DIR, sound.filename);
  if (fs.existsSync(filePath)) { try { fs.unlinkSync(filePath); } catch {} }

  await prisma.bellSoundFile.delete({ where: { id: sound.id } });
  res.json({ ok: true });
});

/**
 * Belső helper a `messages.routes.ts` számára: visszaadja az intro hang
 * abszolút path-ját egy MESSAGE_INTRO kind-ú BellSoundFile id alapján,
 * tenant-szigorúan. Ha nincs találat, null-t ad → a hívó fallback-elhet
 * a default `dingdong.wav`-ra.
 */
export async function resolveIntroSoundPath(tenantId: string, soundId: string): Promise<string | null> {
  const sound = await prisma.bellSoundFile.findFirst({
    where: { id: soundId, tenantId, kind: "MESSAGE_INTRO" },
  });
  if (!sound) return null;
  const fp = path.join(INTRO_AUDIO_DIR, sound.filename);
  if (!fs.existsSync(fp)) return null;
  return fp;
}

// ── Szerkesztési zár ───────────────────────────────────────────────────────

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

// ── Verzió lekérdezés ──────────────────────────────────────────────────────

bellsRouter.get("/version", async (req: Request, res: Response) => {
  const device = await authenticateDevice(req);
  if (!device) return res.status(401).json({ error: "Invalid or missing device key" });

  const today = todayInBudapest();
  const { isHoliday, todayVersion, defaultVersion } =
    await resolveTodayBells(device.tenantId, today);

  res.json({ ok: true, todayVersion, defaultVersion, isHoliday });
});

// ── /today – JWT-vel is elérhető (VirtualPlayer) ──────────────────────────

bellsRouter.get("/today", async (req: Request, res: Response) => {
  let tenantId = tid(req);
  if (!tenantId) {
    const device = await authenticateDevice(req);
    if (!device) return res.status(401).json({ error: "Unauthorized" });
    tenantId = device.tenantId;
  }
  if (!tenantId) return res.status(400).json({ error: "Tenant required" });

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

// ── /sync – ESP32 / native player ─────────────────────────────────────────

bellsRouter.get("/sync", async (req: Request, res: Response) => {
  const device = await authenticateDevice(req);
  if (!device) return res.status(401).json({ error: "Invalid or missing device key" });

  const today = todayInBudapest();
  const { bells, defaultBells, isHoliday, todayVersion, defaultVersion } =
    await resolveTodayBells(device.tenantId, today);

  const sounds = await prisma.bellSoundFile.findMany({
    where: { tenantId: device.tenantId, kind: "SCHEDULE" },
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

// ── Shared helper – SyncEngine is hívja WS SCHEDULE_SYNC push-hoz ─────────────

export async function buildScheduleSyncPayload(tenantId: string): Promise<object> {
  const today = todayInBudapest();
  const { bells, defaultBells, isHoliday, todayVersion, defaultVersion } =
    await resolveTodayBells(tenantId, today);

  const sounds = await prisma.bellSoundFile.findMany({
    where: { tenantId, kind: "SCHEDULE" },
  });

  return {
    type:           "SCHEDULE_SYNC",
    isHoliday,
    todayVersion,
    defaultVersion,
    bells:          bells.map((b: any) => ({ hour: b.hour, minute: b.minute, type: b.type, soundFile: b.soundFile })),
    defaultBells:   defaultBells.map((b: any) => ({ hour: b.hour, minute: b.minute, type: b.type, soundFile: b.soundFile })),
    sounds:         sounds.map((s: any) => ({ filename: s.filename, url: `/audio/bells/${s.filename}`, sizeBytes: s.sizeBytes })),
    updatedAt:      new Date().toISOString(),
  };
}
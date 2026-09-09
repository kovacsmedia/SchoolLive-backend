import { Router, Request, Response, NextFunction } from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import axios from "axios";
import { execSync } from "child_process";
import prisma from "../../prisma";
import { authJwt } from "../../middleware/authJwt";
import { requireTenant } from "../../middleware/tenant";
import { broadcastSyncBells } from "./bell.scheduler";
import { stripAccents } from "../../utils/text";
import { todayInBudapest } from "../../utils/budapest-time";
import { findDeviceByKey } from "../devices/device-key";
import {
  bellSoundTenantDir,
  bellSoundDiskPath,
  bellSoundUrlPath,
  DEFAULT_BELL_SOUNDS,
} from "./bell-sound-paths";

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

const AUDIO_DIR = path.join(process.cwd(), "audio", "bells");
// 4 MB tárhely – az ESP32-S3-N16R8 (16MB flash) particionálásában az
// /audio LittleFS partíción kb. ennyi marad a firmware + littlefs +
// updater partíciók mellett.
const MAX_TOTAL_BYTES = 4 * 1024 * 1024;
const DEFAULT_SOUNDS = ["jelzocsengo.mp3", "kibecsengo.mp3"];

if (!fs.existsSync(AUDIO_DIR)) fs.mkdirSync(AUDIO_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, _file, cb) => {
    // A requireTenant middleware a route-láncban a multer ELŐTT fut, tehát
    // req.tenantId itt már be van állítva. Ha valamiért mégsem, a régi,
    // lapos könyvtárba esünk vissza (működő, csak nem szeparált) – sosem
    // dobunk el egy feltöltést emiatt.
    const tenantId = (req as any).tenantId as string | undefined;
    if (!tenantId) return cb(null, AUDIO_DIR);
    const dir = bellSoundTenantDir(tenantId);
    try {
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    } catch (e) {
      console.error("[BELLS] tenant hang-könyvtár létrehozás hiba:", e);
      cb(null, AUDIO_DIR);
    }
  },
  // Ékezetmentes fájlnév – a downstream eszközöknek (ESP / Python kliens /
  // snapclient) így biztosan nem lesz baja a "csengő.mp3" típusú nevekkel.
  filename: (_req, file, cb) => cb(null, stripAccents(file.originalname)),
});

const upload = multer({
  storage,
  fileFilter: (_req, file, cb) => {
    // .opus KÜLÖN felvéve: a Snapcast-sugárzás maga is Opus-kódekkel megy
    // (ld. snapcast.service.ts pipe-forrás `codec=opus`), ezért natívan
    // feltölthetőnek KELL lennie, nem csak MP3-nak.
    const name = file.originalname.toLowerCase();
    if (
      file.mimetype === "audio/mpeg" ||
      file.mimetype.startsWith("audio/") ||
      name.endsWith(".mp3") ||
      name.endsWith(".opus")
    ) {
      cb(null, true);
    } else {
      cb(new Error("Only audio files allowed"));
    }
  },
});

// A tenant-kontextust KIZÁRÓLAG a requireTenant middleware állítja be
// (req.tenantId), ami szerepkör-tudatos: SUPER_ADMIN-nál az x-tenant-id
// headerből, mindenki másnál a TOKENBŐL veszi.
//
// KORÁBBAN ez a függvény minden hívónál elsőbbséget adott az x-tenant-id
// headernek, a router pedig nem használt requireTenant-et – így egy "A"
// iskola TENANT_ADMIN-ja pusztán a header átírásával olvashatta ÉS
// ÍRHATTA a "B" iskola csengetési rendjét, sablonjait és hangfájljait.
// (Mellékhatásként a multi-node ownership-ellenőrzés is kimaradt.)
function tid(req: Request): string {
  return (req as any).tenantId as string;
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
  // Indexelt feloldás (ld. device-key.ts) – korábban minden KEY-auth eszközre
  // lefutott egy bcrypt.compare, ráadásul a TELJES sorokat behúzva.
  return await findDeviceByKey(deviceKey, true);
}

// Tanév: szeptember 1 – július 1. Ha a mai budapesti dátum >= augusztus,
// az idei szeptember a kezdet; egyébként a tavalyi.
function schoolYearRange(today: Date): { start: Date; end: Date } {
  const y = today.getUTCFullYear();
  const m = today.getUTCMonth(); // 0-indexelt: 7 = augusztus
  const startYear = m >= 7 ? y : y - 1;
  return {
    start: new Date(Date.UTC(startYear, 8, 1)),      // szept 1
    end:   new Date(Date.UTC(startYear + 1, 6, 1)),  // (köv. év) júl 1
  };
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

bellsRouter.get("/templates", authJwt, requireTenant, canEdit, async (req: Request, res: Response) => {
  const templates = await prisma.bellScheduleTemplate.findMany({
    where: { tenantId: tid(req) },
    include: { bells: { orderBy: [{ hour: "asc" }, { minute: "asc" }] } },
    orderBy: { createdAt: "asc" },
  });
  res.json({ ok: true, templates });
});

bellsRouter.post("/templates", authJwt, requireTenant, canEdit, async (req: Request, res: Response) => {
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

bellsRouter.put("/templates/:id", authJwt, requireTenant, canEdit, async (req: Request, res: Response) => {
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

bellsRouter.delete("/templates/:id", authJwt, requireTenant, canEdit, async (req: Request, res: Response) => {
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

bellsRouter.put("/templates/:id/set-default", authJwt, requireTenant, canEdit, async (req: Request, res: Response) => {
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

bellsRouter.get("/calendar", authJwt, requireTenant, canEdit, async (req: Request, res: Response) => {
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

bellsRouter.post("/calendar/init", authJwt, requireTenant, canEdit, async (req: Request, res: Response) => {
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

bellsRouter.put("/calendar/:date", authJwt, requireTenant, canEdit, async (req: Request, res: Response) => {
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

bellsRouter.get("/sounds", authJwt, requireTenant, canEdit, async (req: Request, res: Response) => {
  const sounds = await prisma.bellSoundFile.findMany({
    where: { tenantId: tid(req) },
    orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
  });
  res.json({ ok: true, sounds });
});

bellsRouter.post("/sounds", authJwt, requireTenant, canEdit, upload.single("file"), async (req: Request, res: Response) => {
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

bellsRouter.delete("/sounds/:id", authJwt, requireTenant, canEdit, async (req: Request, res: Response) => {
  const soundId = req.params.id as string;
  const sound   = await prisma.bellSoundFile.findFirst({
    where: { id: soundId, tenantId: tid(req) },
  });
  if (!sound) return res.status(404).json({ error: "Not found" });
  if (sound.isDefault) return res.status(403).json({ error: "Cannot delete default sound" });

  // A feloldón keresztül: a tenant saját könyvtárában lévő fájlt törli, és
  // csak akkor nyúl a régi, lapos elrendezésű fájlhoz, ha ennek a tenantnak
  // ott van a hangja. Korábban vakon `AUDIO_DIR/<filename>`-t törölt, ami
  // névütközésnél EGY MÁSIK ISKOLA hangfájlját vitte el.
  // FONTOS: a feloldó mostantól default hangra esik vissza, ha a kért fájl
  // nincs meg – törlésnél tehát a `isFallback` ágat KI KELL zárni, különben
  // egy hiányzó feltöltés törlése a KÖZÖS default hangot vinné el.
  const resolvedForDelete = bellSoundDiskPath(tid(req), sound.filename);
  if (resolvedForDelete && !resolvedForDelete.isFallback) {
    try { fs.unlinkSync(resolvedForDelete.path); }
    catch (e) { console.error(`[BELLS] hangfájl törlés hiba (${resolvedForDelete.path}):`, e); }
  }

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

bellsRouter.get("/intro-sounds", authJwt, requireTenant, canEdit, async (req: Request, res: Response) => {
  const sounds = await prisma.bellSoundFile.findMany({
    where:   { tenantId: tid(req), kind: "MESSAGE_INTRO" },
    orderBy: [{ createdAt: "asc" }],
  });
  res.json({ ok: true, sounds });
});

bellsRouter.post("/intro-sounds", authJwt, requireTenant, canEdit, introUpload.single("file"), async (req: Request, res: Response) => {
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

bellsRouter.delete("/intro-sounds/:id", authJwt, requireTenant, canEdit, async (req: Request, res: Response) => {
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

bellsRouter.post("/lock", authJwt, requireTenant, canEdit, async (req: Request, res: Response) => {
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

bellsRouter.delete("/lock", authJwt, requireTenant, canEdit, async (req: Request, res: Response) => {
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

// ── /today – kétféle hívó, kétféle hitelesítés ────────────────────────────
//
// Eszköz (ESP32 / natív kliens): `x-device-key` header → a tenant a Device
//   rekordból jön.
// Böngésző (VirtualPlayer / admin): JWT → authJwt + requireTenant, a tenant
//   a tokenből (SUPER_ADMIN-nál az x-tenant-id headerből).
//
// KORÁBBAN ez a route hitelesítés NÉLKÜL kiszolgált bárkit, aki küldött egy
// `x-tenant-id` headert (a régi `tid()` vakon elhitte), az app.ts-ben lévő,
// helyesen védett `/bells/today` pedig SOSEM futott le, mert az
// `app.use("/bells", bellsRouter)` előbb van regisztrálva, mint az.

async function sendTodayBells(res: Response, tenantId: string) {
  const today = todayInBudapest();
  const { bells, isHoliday } = await resolveTodayBells(tenantId, today);

  // A hangfájlok TÉNYLEGES URL-je fájlnevenként. A tenant-szeparált tárolás
  // (audio/bells/<tenantId>/…) óta a kliens NEM tudja magától összerakni az
  // utat – a szerver tudja, melyik fájl van a tenant könyvtárában és melyik
  // maradt a régi, lapos helyen. Additív mező: aki nem ismeri, figyelmen
  // kívül hagyja. (A /bells/sync `sounds[]` tömbje ugyanezt adja az
  // eszköz-kulccsal hitelesített klienseknek.)
  const soundUrls: Record<string, string> = {};
  for (const b of bells as any[]) {
    if (b.soundFile && !soundUrls[b.soundFile]) {
      soundUrls[b.soundFile] = bellSoundUrlPath(tenantId, b.soundFile);
    }
  }

  return res.json({
    ok: true,
    isHoliday,
    bells: bells.map((b: any) => ({
      hour:      b.hour,
      minute:    b.minute,
      type:      b.type,
      soundFile: b.soundFile,
    })),
    soundUrls,
  });
}

// Első lépcső: ha van device-kulcs, azzal hitelesítünk és válaszolunk.
// Ha nincs, `next()` – a kérés a JWT-ágra (authJwt + requireTenant) esik.
async function todayViaDeviceKey(req: Request, res: Response, next: NextFunction) {
  if (!req.headers["x-device-key"]) return next();
  try {
    const device = await authenticateDevice(req);
    if (!device) return res.status(401).json({ error: "Invalid device key" });
    return await sendTodayBells(res, device.tenantId);
  } catch (err) {
    console.error("[BELLS/today] device-ág hiba:", err);
    return res.status(500).json({ error: "Failed to fetch today bells" });
  }
}

bellsRouter.get("/today", todayViaDeviceKey, authJwt, requireTenant, async (req: Request, res: Response) => {
  try {
    return await sendTodayBells(res, tid(req));
  } catch (err) {
    console.error("[BELLS/today] JWT-ág hiba:", err);
    return res.status(500).json({ error: "Failed to fetch today bells" });
  }
});

// ── Teljes tanévnyi naptár (szept 1 – júl 1) – minden sablon + minden
// naptár-kivétel (ünnepnap / eltérő sablon adott napra) + a hangfájlok.
// Ezzel egy eszköz teljesen offline is ki tudja számolni BÁRMELYIK jövőbeli
// nap csengetési rendjét, nem csak a "ma"-t – nem kell online lennie azon a
// napon, amikor egy naptár-kivétel életbe lép.
async function buildFullYearCalendar(tenantId: string): Promise<{
  schoolYear:       { start: string; end: string };
  defaultTemplateId: string | null;
  templates:        Array<{ id: string; isDefault: boolean; bells: Array<{ hour: number; minute: number; type: string; soundFile: string }> }>;
  calendar:         Array<{ date: string; isHoliday: boolean; templateId: string | null }>;
  sounds:           Array<{ filename: string; url: string; sizeBytes: number }>;
  fullYearVersion:  string;
}> {
  const { start, end } = schoolYearRange(todayInBudapest());

  const [templates, calendarDays] = await Promise.all([
    prisma.bellScheduleTemplate.findMany({
      where:   { tenantId },
      include: { bells: { orderBy: [{ hour: "asc" }, { minute: "asc" }] } },
    }),
    prisma.bellCalendarDay.findMany({
      where:   { tenantId, date: { gte: start, lt: end } },
      orderBy: { date: "asc" },
    }),
  ]);

  const templatesOut = templates.map((t: any) => ({
    id:        t.id,
    isDefault: t.isDefault,
    bells:     t.bells.map((b: any) => ({ hour: b.hour, minute: b.minute, type: b.type, soundFile: b.soundFile })),
  }));
  const calendarOut = calendarDays.map((d: any) => ({
    date:       d.date.toISOString().slice(0, 10),
    isHoliday:  d.isHoliday,
    templateId: d.templateId,
  }));
  // Ugyanaz a garantált lista, mint a /bells/sync `sounds` mezőjében – így a
  // `fullYearVersion` is változik, ha egy default hang bekerül/frissül, tehát
  // az eszközök újraszinkronizálnak.
  const soundsOut = await buildSoundsList(
    tenantId,
    templatesOut.flatMap((t: any) => t.bells.map((b: any) => b.soundFile)).filter(Boolean),
  );

  const fullYearVersion = crypto.createHash("md5")
    .update(JSON.stringify({ templatesOut, calendarOut, soundsOut }))
    .digest("hex").slice(0, 12);

  return {
    schoolYear:        { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) },
    defaultTemplateId: templates.find((t: any) => t.isDefault)?.id ?? null,
    templates:         templatesOut,
    calendar:          calendarOut,
    sounds:            soundsOut,
    fullYearVersion,
  };
}

// ── /sync – ESP32 / native player ─────────────────────────────────────────

bellsRouter.get("/sync", async (req: Request, res: Response) => {
  const device = await authenticateDevice(req);
  if (!device) return res.status(401).json({ error: "Invalid or missing device key" });

  const today = todayInBudapest();
  const { bells, defaultBells, isHoliday, todayVersion, defaultVersion } =
    await resolveTodayBells(device.tenantId, today);

  const fullYear = await buildFullYearCalendar(device.tenantId);

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
    // A default hangokat és minden ténylegesen hivatkozott fájlnevet MINDIG
    // tartalmaz – az eszköz ebből takarít, ld. buildSoundsList().
    sounds: await buildSoundsList(device.tenantId, [
      ...bells.map((b: any) => b.soundFile),
      ...defaultBells.map((b: any) => b.soundFile),
      ...((fullYear.templates as any[]) ?? []).flatMap((t: any) =>
        (t?.bells ?? []).map((b: any) => b.soundFile)),
    ].filter(Boolean)),
    updatedAt: new Date().toISOString(),
    // Új, additív mezők: a teljes tanévnyi naptár. A régi kliensek ezeket
    // egyszerűen figyelmen kívül hagyják (bells/defaultBells/sounds
    // változatlan formában megmarad "ma" nézetnek).
    schoolYear:        fullYear.schoolYear,
    defaultTemplateId: fullYear.defaultTemplateId,
    templates:         fullYear.templates,
    calendar:          fullYear.calendar,
    fullYearVersion:   fullYear.fullYearVersion,
  });
});

// ── Shared helper – SyncEngine is hívja WS SCHEDULE_SYNC push-hoz ─────────────

// ── Hanglista összeállítása a klienseknek ──────────────────────────────────
//
// KRITIKUS: az eszközök (ESP32 BellManager) ebből a listából takarítanak – a
// LittleFS-ről TÖRLIK azt az .mp3-at, ami itt nem szerepel. Ha tehát a lista
// hiányos, az eszköz kidobja a saját (gyári vagy korábban letöltött) hangját,
// és a rá hivatkozó csengetés NÉMÁN elmarad.
//
// Ezért a lista MINDIG tartalmazza:
//   1. a tenant saját feltöltött hangjait (BellSoundFile),
//   2. a default hangokat (jelzocsengo/kibecsengo) – ezek a firmware LittleFS
//      képében is benne vannak, és minden `soundFile` nélküli bejegyzés
//      ezekre hivatkozik,
//   3. minden olyan fájlnevet, amire a csengetési rend TÉNYLEGESEN hivatkozik,
//      akkor is, ha a hozzá tartozó DB-rekord időközben törlődött.
async function buildSoundsList(
  tenantId: string,
  referencedFilenames: string[] = [],
): Promise<Array<{ filename: string; url: string; sizeBytes: number }>> {
  const rows = await prisma.bellSoundFile.findMany({
    where: { tenantId, kind: "SCHEDULE" },
  });

  const out = new Map<string, { filename: string; url: string; sizeBytes: number }>();

  const add = (filename: string, sizeBytes?: number) => {
    if (!filename || out.has(filename)) return;
    const resolved = bellSoundDiskPath(tenantId, filename);
    // Csak a TÉNYLEGESEN létező fájl kerülhet a listába. A default-fallback
    // (`isFallback`) itt NEM jó: az URL a hiányzó fájlra mutatna, amit az
    // eszköz 404-re futva újra és újra próbálna letölteni. A hiányzó hangot
    // a kliens a SAJÁT gyári defaultjával pótolja (ld. BellManager
    // resolveLocalSound), a szerver pedig a snap-ágon szintén defaulttal
    // csenget – csend egyik esetben sem lesz.
    if (!resolved || resolved.isFallback) return;
    let size = sizeBytes ?? 0;
    if (!size) {
      try { size = fs.statSync(resolved.path).size; } catch { size = 0; }
    }
    out.set(filename, {
      filename,
      url: bellSoundUrlPath(tenantId, filename),
      sizeBytes: size,
    });
  };

  for (const r of rows as any[]) add(r.filename, r.sizeBytes);
  for (const name of DEFAULT_BELL_SOUNDS) add(name);
  for (const name of referencedFilenames) add(name);

  return [...out.values()];
}

export async function buildScheduleSyncPayload(tenantId: string): Promise<object> {
  const today = todayInBudapest();
  const { bells, defaultBells, isHoliday, todayVersion, defaultVersion } =
    await resolveTodayBells(tenantId, today);

  const fullYear = await buildFullYearCalendar(tenantId);

  // A ténylegesen hivatkozott fájlnevek: a mai + a default menetrendből ÉS a
  // teljes tanévnyi sablonokból, hogy egy jövőbeli nap hangja se hiányozzon.
  const referenced = new Set<string>();
  for (const b of [...(bells as any[]), ...(defaultBells as any[])]) {
    if (b?.soundFile) referenced.add(b.soundFile);
  }
  for (const t of (fullYear.templates as any[] ?? [])) {
    for (const b of (t?.bells ?? [])) if (b?.soundFile) referenced.add(b.soundFile);
  }

  const sounds = await buildSoundsList(tenantId, [...referenced]);

  return {
    type:           "SCHEDULE_SYNC",
    isHoliday,
    todayVersion,
    defaultVersion,
    bells:          bells.map((b: any) => ({ hour: b.hour, minute: b.minute, type: b.type, soundFile: b.soundFile })),
    defaultBells:   defaultBells.map((b: any) => ({ hour: b.hour, minute: b.minute, type: b.type, soundFile: b.soundFile })),
    sounds,
    updatedAt:      new Date().toISOString(),
    // Additív mezők – teljes tanévnyi naptár (ld. buildFullYearCalendar).
    schoolYear:        fullYear.schoolYear,
    defaultTemplateId: fullYear.defaultTemplateId,
    templates:         fullYear.templates,
    calendar:          fullYear.calendar,
    fullYearVersion:   fullYear.fullYearVersion,
  };
}
// src/modules/radio/radio.routes.ts

import { env, rehostUrl } from "../../config/env";
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
    const ext  = path.extname(file.originalname).toLowerCase() || AUDIO_EXT;
    const hash = crypto.randomBytes(12).toString("hex");
    cb(null, `radio_${hash}${ext}`);
  },
});

import { stripAccents, fixUploadFilename } from "../../utils/text";
import { AUDIO_EXT, opusOutputArgs, ytDlpAudioArgs, normalizeToStoredFormat, withAudioExt } from "../../utils/audio-format";
import { resolveYtDlp } from "../../utils/binaries";

/*
 * A korábbi helyi változat FELTÉTEL NÉLKÜL futtatta a latin1→utf8 átalakítást.
 * Ez a mojibake-elt neveket megjavította, de a HELYESEN dekódoltakat (amikor a
 * kliens RFC 5987 `filename*`-ot küld) elrontotta volna: az "ö" (U+00F6) egyetlen
 * 0xF6 bájttá csonkul, ami érvénytelen UTF-8 → U+FFFD. A közös
 * `fixUploadFilename()` ezért csak veszteségmentes esetben nyúl hozzá.
 */
function fixEncoding(name: string): string {
  return stripAccents(fixUploadFilename(name));
}

const upload = multer({
  storage,
  /*
   * 500 MB.
   *
   * Az élő adás felvétele Opus 192 kbps-en ≈ 1,4 MB/perc, tehát ez
   * nagyjából 6 óra összefüggő felvételnek felel meg. A korábbi 200 MB
   * (~2 óra) egy hosszabb rendezvény közvetítésénél kevés lett volna.
   *
   * FIGYELEM: a fordított proxy (nginx) `client_max_body_size` értékének is
   * legalább ekkorának kell lennie, különben a kérés MÁR IDE SEM JUT EL,
   * és a kliens 413-at kap.
   */
  limits: { fileSize: 500 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    // .opus KÜLÖN felvéve: a Snapcast-sugárzás maga is Opus-kódekkel megy
    // (ld. snapcast.service.ts pipe-forrás `codec=opus`), ezért natívan
    // feltölthetőnek KELL lennie, nem csak az `audio/*` mimetype-fallback-en
    // keresztül (ami böngészőtől/OS-től függően nem mindig ad helyes
    // mimetype-ot .opus fájlra).
    const allowed = [".mp3", ".wav", ".ogg", ".m4a", ".aac", ".opus"];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext) || file.mimetype.startsWith("audio/")) cb(null, true);
    else cb(new Error("Only audio files are allowed"));
  },
});

function tid(req: Request): string { return (req as any).tenantId as string; }
function uid(req: Request): string { return (req as any).user?.sub as string; }
function role(req: Request): string { return (req as any).user?.role ?? ""; }
function canWrite(r: string): boolean { return ["SUPER_ADMIN", "TENANT_ADMIN", "ORG_ADMIN"].includes(r); }
function baseUrl(): string { return env.BASE_URL; }
function paramId(req: Request): string { return String(req.params.id); }

/** Másodperc → h:mm:ss / m:ss – a könyvtárban látszó fájlnévhez. */
function fmtHms(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`
    : `${m}:${String(r).padStart(2, "0")}`;
}

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

    /*
     * A HANGTÁR IS CSAK OPUS 96k-T TÁROL.
     *
     * A felület bármilyen kodekű feltöltést elfogad (ld. a fenti allowlistet),
     * de a tárolt alak mindig egységes – így a lejátszási láncban sehol nem
     * kell formátumot találgatni, és a lemezen sem gyűlnek vegyes fájlok.
     */
    const norm = await normalizeToStoredFormat(req.file.path, req.file.filename);
    if (!norm) {
      try { fs.unlinkSync(req.file.path); } catch {}
      return res.status(400).json({ error: "A hangfájlt nem sikerült átkódolni." });
    }

    const storedFilename = path.basename(norm.path);
    const durationSec = await getAudioDurationSec(norm.path);
    const fileUrl     = `${baseUrl()}/uploads/radio/${storedFilename}`;
    const radioFile = await prisma.radioFile.create({
      data: { tenantId: tid(req), createdById: uid(req), filename: storedFilename,
              originalName: fixEncoding(withAudioExt(req.file.originalname)), sizeBytes: norm.size, durationSec, fileUrl },
      include: { createdBy: { select: { id: true, displayName: true, email: true } } },
    });
    return res.status(201).json({ ok: true, file: { ...radioFile, _count: { schedules: 0 } } });
  } catch (err: any) {
    if (req.file) { try { fs.unlinkSync(req.file.path); } catch {} }
    if (err?.code === "P2002") return res.status(409).json({ error: "File already exists" });
    console.error(err); return res.status(500).json({ error: "Upload failed" });
  }
});

/**
 * Hangtár-fájl átnevezése.
 *
 * Csak a MEGJELENÍTETT nevet (`originalName`) írja át – a lemezen lévő
 * `filename` érintetlen marad. Ez szándékos: arra a `RadioSchedule` és a
 * `YoutubePlaylist` is hivatkozik, és a `fileUrl` is abból épül. Egy
 * felhasználói átnevezés nem érhet el odáig, hogy egy ütemezett lejátszás
 * fájlja eltűnjön alóla.
 */
router.patch("/files/:id/rename", authJwt, requireTenant, async (req: Request, res: Response) => {
  try {
    if (!canWrite(role(req))) return res.status(403).json({ error: "Forbidden" });
    const id  = String(req.params.id);
    const raw = String((req.body ?? {}).name ?? "").trim();

    const file = await prisma.radioFile.findFirst({ where: { id, tenantId: tid(req) } });
    if (!file) return res.status(404).json({ error: "Not found" });

    // A kiterjesztést a szerver tartja meg; a felület nem is mutatja.
    const ext  = path.extname(file.originalName) || path.extname(file.filename) || AUDIO_EXT;
    const base = raw.replace(/\.[^.]+$/, "").replace(/[\\/:*?"<>|]/g, "").trim();
    if (!base) return res.status(400).json({ error: "Invalid name" });

    const newName = base.slice(0, 120) + ext;
    await prisma.radioFile.update({ where: { id: file.id }, data: { originalName: fixEncoding(newName) } });

    return res.json({ ok: true, originalName: newName });
  } catch (err) {
    console.error("[radio] rename", err);
    return res.status(500).json({ error: "Rename failed" });
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

// Közös ütemezés-létrehozási logika (ütközés-ellenőrzéssel), amit a normál
// `/schedules` (meglévő RadioFile-ra) ÉS a `/youtube/schedule` (előbb
// letöltött, majd RadioFile-ként tárolt YouTube-videóra) is használ – ld.
// utóbbinál a "YouTube – időzített lejátszás" szakaszt lent.
async function createSchedule(params: {
  tid: string; uid: string;
  /** Fájl-alapú ütemezésnél kötelező; internetrádiónál helyette streamUrl jön. */
  radioFileId?: string | null;
  streamUrl?: string | null;
  streamTitle?: string | null;
  targetType: string; targetId?: string | null; scheduledAt: Date; endsAt?: Date | null;
  /** Indulási pozíció mp-ben; 0/undefined = a hang elejétől. */
  startSec?: number | null;
}): Promise<
  | { ok: true; schedule: any }
  | { ok: false; status: number; error: string; conflict?: any }
> {
  const isStream = !params.radioFileId;
  if (isStream && !params.streamUrl) {
    return { ok: false, status: 400, error: "radioFileId vagy streamUrl kötelező" };
  }

  let fileId: string | null = null;
  /*
   * A lejátszás VÉGE – az ütközésvizsgálat alapja.
   *
   * Fájlnál a hossz adja (vagy a megadott vége-időpont, ha az korábbi).
   * Streamnél nincs hossz: ott KIZÁRÓLAG a megadott vége-időpont zárja le,
   * és ha az sincs, a lejátszás nyitott végű – ilyenkor (a fájlok ismeretlen
   * hosszához hasonlóan) nem vizsgálunk ütközést, mert nincs mihez mérni.
   */
  let ownEnd: Date | null = params.endsAt ?? null;

  if (!isStream) {
    const file = await prisma.radioFile.findFirst({
      where: { id: String(params.radioFileId), tenantId: params.tid },
      select: { id: true, durationSec: true },
    });
    if (!file) return { ok: false, status: 404, error: "Radio file not found" };
    fileId = file.id;
    if (file.durationSec) {
      const byDuration = new Date(params.scheduledAt.getTime() + file.durationSec * 1000);
      ownEnd = ownEnd && ownEnd < byDuration ? ownEnd : byDuration;
    }
  }

  if (ownEnd) {
    const candidates = await prisma.radioSchedule.findMany({
      where: {
        tenantId: params.tid, status: { in: ["PENDING", "DISPATCHED"] },
        targetType: params.targetType as any,
        ...(params.targetId ? { targetId: String(params.targetId) } : {}),
        scheduledAt: { lt: ownEnd },
      },
      include: { radioFile: { select: { durationSec: true, originalName: true } } },
      orderBy: { scheduledAt: "asc" },
    });
    for (const conflict of candidates) {
      // Ugyanaz a sorrend, mint fent: a megadott vége-időpont erősebb, mint a
      // fájlhossz; stream + vége nélkül a `null` = nyitott végű ütközés.
      const byDuration = conflict.radioFile?.durationSec
        ? new Date(conflict.scheduledAt.getTime() + conflict.radioFile.durationSec * 1000)
        : null;
      const conflictEnd = conflict.endsAt && (!byDuration || conflict.endsAt < byDuration)
        ? conflict.endsAt
        : byDuration;
      if (conflict.status === "DISPATCHED" && conflictEnd && conflictEnd < new Date()) continue;
      if (!conflictEnd || conflictEnd > params.scheduledAt) {
        return {
          ok: false, status: 409, error: "Időütközés",
          conflict: {
            id: conflict.id, scheduledAt: conflict.scheduledAt,
            originalName: conflict.radioFile?.originalName ?? conflict.streamTitle ?? "Internetrádió",
            status: conflict.status,
          },
        };
      }
    }
  }

  const schedule = await prisma.radioSchedule.create({
    data: {
      // Csak pozitív, véges értéket tárolunk; minden más az elejét jelenti.
      startSec: Number.isFinite(Number(params.startSec)) && Number(params.startSec) > 0
        ? Math.round(Number(params.startSec))
        : null,
      tenantId: params.tid, createdById: params.uid, radioFileId: fileId,
      streamUrl:   isStream ? String(params.streamUrl) : null,
      streamTitle: isStream ? (params.streamTitle?.trim() || "Internetrádió") : null,
      targetType: params.targetType as any, targetId: params.targetId ? String(params.targetId) : null,
      scheduledAt: params.scheduledAt, endsAt: params.endsAt ?? null, status: "PENDING",
    },
    include: { radioFile: { select: { id: true, originalName: true, durationSec: true, fileUrl: true } } },
  });
  return { ok: true, schedule };
}

router.post("/schedules", authJwt, requireTenant, async (req: Request, res: Response) => {
  try {
    if (!canWrite(role(req))) return res.status(403).json({ error: "Forbidden" });
    const { radioFileId, targetType, targetId, scheduledAt, endsAt, startSec } = req.body ?? {};
    if (!radioFileId || !targetType || !scheduledAt) return res.status(400).json({ error: "radioFileId, targetType and scheduledAt are required" });
    const scheduledDate = new Date(scheduledAt);
    if (isNaN(scheduledDate.getTime())) return res.status(400).json({ error: "Invalid scheduledAt date" });
    if (scheduledDate < new Date())     return res.status(400).json({ error: "scheduledAt must be in the future" });

    /*
     * Lejátszás vége – OPCIONÁLIS.
     *
     * Ha a hang hosszabb, itt lekeverjük és leállítjuk. Rövidebbnél nincs
     * hatása. Csak azt követeljük meg, hogy a kezdés UTÁN legyen – egy
     * elgépelt, korábbi időpont némán elnyelné az egész lejátszást.
     */
    let endsAtDate: Date | null = null;
    if (endsAt) {
      endsAtDate = new Date(endsAt);
      if (isNaN(endsAtDate.getTime())) return res.status(400).json({ error: "Invalid endsAt date" });
      if (endsAtDate <= scheduledDate) {
        return res.status(400).json({ error: "endsAt must be after scheduledAt" });
      }
    }

    const result = await createSchedule({
      startSec,
      tid: tid(req), uid: uid(req), radioFileId: String(radioFileId),
      targetType, targetId, scheduledAt: scheduledDate, endsAt: endsAtDate,
    });
    if (!result.ok) return res.status(result.status).json({ error: result.error, conflict: (result as any).conflict });
    return res.status(201).json({ ok: true, schedule: result.schedule });
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

const YT_DLP_BIN = resolveYtDlp();

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

/**
 * Mint a `runCmd`, de menet közben jelenti a haladást.
 *
 * A yt-dlp `--newline` mellett minden haladás-frissítést KÜLÖN SORBA ír
 * (`[download]  12.3% of ...`), enélkül `\r`-rel írná felül ugyanazt a sort,
 * és soralapú feldolgozással nem lehetne kiolvasni.
 */
function runCmdProgress(
  bin: string,
  args: string[],
  onPercent: (pct: number) => void,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = _spawn(bin, args);
    let out = ""; let err = ""; let buf = "";

    const consume = (chunk: string) => {
      buf += chunk;
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() ?? "";
      for (const line of lines) {
        const m = line.match(/\[download\]\s+(\d+(?:\.\d+)?)%/);
        if (m) onPercent(Math.max(0, Math.min(100, parseFloat(m[1]))));
      }
    };

    proc.stdout.on("data", (d: Buffer) => { const t = d.toString(); out += t; consume(t); });
    proc.stderr.on("data", (d: Buffer) => { err += d.toString(); });
    proc.on("close", (code: number) => {
      if (code !== 0) return reject(new Error(`${bin} exited ${code}: ${err.slice(-300)}`));
      resolve(out.trim());
    });
    proc.on("error", (e: Error) => reject(new Error(`spawn error: ${e.message}`)));
  });
}

/*
 * YouTube-letöltés háttérfeladatként.
 *
 * Egy több órás videó letöltése és átkódolása PERCEKIG tart – egyetlen
 * HTTP-kérésben kivárni törékeny (kliens-időkorlát, proxy-timeout), és a
 * felhasználó sem lát belőle semmit. Ezért a POST azonnal visszatér egy
 * azonosítóval, a munka a háttérben fut, a felület pedig lekérdezi az
 * állapotot. Ugyanaz a minta, mint a lejátszási lista építésénél.
 */
type YtDownloadJob = {
  tenantId: string;
  status:   "RUNNING" | "DONE" | "ERROR";
  percent:  number;
  error?:   string;
  radioFile?: any;
  startedAt: number;
};
const ytDownloadJobs = new Map<string, YtDownloadJob>();

/** Egy órásnál régebbi bejegyzések eldobása – ne nőjön a memória. */
function pruneYtDownloadJobs(): void {
  const cutoff = Date.now() - 60 * 60 * 1000;
  for (const [id, job] of ytDownloadJobs.entries()) {
    if (job.startedAt < cutoff) ytDownloadJobs.delete(id);
  }
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
      await runCmd(YT_DLP_BIN, [...ytDlpAudioArgs(),"--no-playlist","--output",outTmpl,"--no-warnings",item.youtubeUrl]);
      const files = fs.readdirSync(tmpDir).filter(f => f.startsWith(`track_${String(i).padStart(3,"0")}`));
      if (files.length === 0) throw new Error(`yt-dlp: letöltés sikertelen: ${item.youtubeUrl}`);
      downloadedFiles.push(path.join(tmpDir, files[0]));
    }
    fs.writeFileSync(concatFile, downloadedFiles.map(f => `file '${f}'`).join("\n"));
    const hash       = crypto.randomBytes(12).toString("hex");
    const filename   = `radio_yt_${hash}${AUDIO_EXT}`;
    const outputPath = path.join(RADIO_UPLOAD_DIR, filename);
    await runCmd("ffmpeg", ["-y","-f","concat","-safe","0","-i",concatFile,...opusOutputArgs(),outputPath]);
    if (!fs.existsSync(outputPath)) throw new Error("ffmpeg: kimeneti MP3 nem jött létre");
    const sizeBytes   = fs.statSync(outputPath).size;
    const durationSec = await getAudioDurationSec(outputPath);
    const fileUrl     = `${baseUrl()}/uploads/radio/${filename}`;
    const radioFile   = await prisma.radioFile.create({ data: { tenantId, filename, originalName: `${playlist.name}${AUDIO_EXT}`, sizeBytes, durationSec, fileUrl, createdById } });
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
      // Internetrádiónál nincs fájlhossz: a vége-időpont dönt, és ha az sincs,
      // a stream kézi leállításig szól – tehát MOST is szól, ezt zárjuk le.
      if (!s.radioFile) return s.endsAt ? now < s.endsAt : true;
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

// GET /radio/snap-playing
// A snap-mixer ÉLŐ állapotából adja vissza, hogy épp megy-e RADIO a tenant
// snap-pipe-ján. Akkor is "playing"-et jelez, ha pillanatnyilag egy bell/TTS
// megszakította a rádiót (pausedStack-en van) – tehát a "rádiózunk éppen?"
// kérdésre helyes választ ad oldal-újratöltés / másik user login után is.
//
// Válasz: { ok, playing: { name, source: "stream"|"file" } | null }
router.get("/snap-playing", authJwt, requireTenant, async (req: Request, res: Response) => {
  try {
    const { SnapcastService } = await import("../snapcast/snapcast.service");
    const playing = SnapcastService.getRadioPlaying(tid(req));
    /*
     * `liveInput`: megy-e ÉPPEN élő hangbemenet a tenanton.
     *
     * A kezelői felület monitorozás-gombja ebből tudja, hogy figyelmeztetnie
     * kell-e gerjedésre (a mikrofon és a monitorozott hangszóró tipikusan
     * ugyanazon a gépen van). SZÁNDÉKOSAN külön mező, nem a `playing.name`
     * szövegére illesztünk: az a felhasználó által is átírható cím, és
     * nyelvfüggő lenne.
     */
    return res.json({
      ok: true,
      playing,
      liveInput: SnapcastService.isLiveInputActive(tid(req)),
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Failed to fetch snap-playing state" });
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

// GET /radio/yt-live-url – közvetlen, azonnal streamelhető audio-CDN-URL
// feloldása egy YouTube linkből ("YouTube fül" élő böngésző+lejátszó,
// "🔴 Élő adásba küldés" gomb). FONTOS: ez egy LEJÁRÓ, aláírt Google-CDN-link
// (jellemzően pár órán belül lejár) – csak azonnali indításra jó, IDŐZÍTETT
// lejátszáshoz a `/youtube/schedule` route-ot kell használni, ami előbb
// letölti a videót (ld. lent).
router.get("/yt-live-url", authJwt, requireTenant, async (req: Request, res: Response) => {
  if (!canWrite(role(req))) return res.status(403).json({ error: "Forbidden" });
  const url = String(req.query.url ?? "").trim();
  if (!url || !isYoutubeUrl(url)) return res.status(400).json({ ok: false, error: "Érvényes YouTube URL szükséges" });
  try {
    const [meta, directUrlRaw] = await Promise.all([
      runCmd(YT_DLP_BIN, ["--print", "%(title)s|||%(duration)s", "--no-playlist", "--no-warnings", "--skip-download", url]),
      runCmd(YT_DLP_BIN, ["-f", "bestaudio", "-g", "--no-playlist", "--no-warnings", url]),
    ]);
    const [title, durationRaw] = meta.split("|||");
    const durationSec = Math.round(parseFloat(durationRaw));
    // `-g` néha több sort ad vissza (pl. külön video+audio URL) – bestaudio
    // szűrővel egy audio-only formátumot kérünk, az első sor a helyes.
    const resolvedUrl = directUrlRaw.split("\n").map(l => l.trim()).find(Boolean);
    if (!resolvedUrl) return res.status(422).json({ ok: false, error: "Nem sikerült feloldani az audio URL-t" });
    return res.json({
      ok: true,
      url: resolvedUrl,
      title: title?.trim() || "YouTube videó",
      durationSec: isNaN(durationSec) ? null : durationSec,
    });
  } catch (err: any) {
    console.error("[yt-live-url]", err?.message);
    return res.status(422).json({ ok: false, error: "Nem sikerült előkészíteni az élő lejátszást" });
  }
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
    const filename   = `radio_${hash}_edited${AUDIO_EXT}`;
    const outputPath = path.join(RADIO_UPLOAD_DIR, filename);
    const fadeStart  = Math.max(0, trimSec - fadeOut);
    await runCmd("ffmpeg", ["-y","-i",inputPath,"-t",String(trimSec),"-af",`afade=t=out:st=${fadeStart}:d=${fadeOut}`,...opusOutputArgs(),outputPath]);
    const sizeBytes   = fs.statSync(outputPath).size;
    const durationSec = await getAudioDurationSec(outputPath);
    const fileUrl     = `${baseUrl()}/uploads/radio/${filename}`;
    const baseName    = radioFile.originalName.replace(/\.[^.]+$/, "");
    const editedName  = fixEncoding(`${baseName}-edited${AUDIO_EXT}`);
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
          await runCmd(YT_DLP_BIN, [...ytDlpAudioArgs(),"--no-playlist","--output",`${outBase}.%(ext)s`,"--no-warnings",item.url]);
          const found = fs.readdirSync(tmpDir).find(f => f.startsWith(`track_${String(i).padStart(3,"0")}`));
          if (!found) throw new Error(`letöltés sikertelen: ${item.url}`);
          downloadedFiles.push(path.join(tmpDir, found));
        } else {
          const localFilename = item.url.split("/").pop()?.split("?")[0];
          const localPath = localFilename ? path.join(RADIO_UPLOAD_DIR, localFilename) : null;
          if (localPath && fs.existsSync(localPath)) { const dest = `${outBase}${path.extname(localPath) || ".bin"}`; fs.copyFileSync(localPath, dest); downloadedFiles.push(dest); }
          else if (item.url.startsWith("http")) {
            const https = await import("https"); const http = await import("http");
            const dest = `${outBase}.bin`;
            await new Promise<void>((resolve, reject) => { const mod = item.url.startsWith("https") ? https.default : http.default; const file = fs.createWriteStream(dest); mod.get(item.url, resp => { resp.pipe(file); file.on("finish", () => { file.close(); resolve(); }); }).on("error", reject); });
            downloadedFiles.push(dest);
          } else throw new Error(`Ismeretlen forrás: ${item.url}`);
        }
      }
      /*
       * A CONCAT DEMUXER AZONOS KODEKET KÖVETEL.
       *
       * A források vegyesek: a yt-dlp már Opus 96k-t ad, egy helyi hangtár-fájl
       * viszont lehet még régi MP3, egy HTTP-forrás pedig bármi. Kodek- vagy
       * csatornaszám-eltérésnél a demuxer NÉMÁN eldobhat sávokat – pontosan ez
       * a hibaosztály okozta a TTS-ben a "csak az intro szól" hibát.
       *
       * Ezért minden elemet a rendszer egységes formátumára hozunk. Ami már
       * Opus 96k, azt a normalizáló változatlanul hagyja, tehát a yt-dlp-vel
       * letöltött sávok NEM kapnak felesleges második generációt.
       */
      for (let i = 0; i < downloadedFiles.length; i++) {
        const norm = await normalizeToStoredFormat(downloadedFiles[i], path.basename(downloadedFiles[i]));
        if (!norm) throw new Error(`Nem sikerult egyseges formatumra hozni: ${downloadedFiles[i]}`);
        downloadedFiles[i] = norm.path;
      }

      const concatFile = path.join(tmpDir, "concat.txt");
      fs.writeFileSync(concatFile, downloadedFiles.map(f => `file '${f}'`).join("\n"));
      // Opus output – a snap stream natívan opus codec-kel megy a klienseknek,
      // és a kis fájlméret is előnyös. 96 kbps "audio" alkalmazás (zenére jó).
      const hash = crypto.randomBytes(12).toString("hex");
      const filename = `radio_custom_${hash}.opus`;
      const outputPath = path.join(RADIO_UPLOAD_DIR, filename);
      await runCmd("ffmpeg", [
        "-y", "-f", "concat", "-safe", "0", "-i", concatFile,
        ...opusOutputArgs(),
        outputPath,
      ]);
      const sizeBytes = fs.statSync(outputPath).size; const durationSec = await getAudioDurationSec(outputPath); const fileUrl = `${baseUrl()}/uploads/radio/${filename}`;
      const radioFile = await prisma.radioFile.create({ data: { tenantId, createdById, filename, originalName: fixEncoding(`${name.trim()}.opus`), sizeBytes, durationSec, fileUrl } });
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

// ═══════════════════════════════════════════════════════════════════════════
// INTERNET RÁDIÓ – stream URL forwarding a snap pipe-ba
// ═══════════════════════════════════════════════════════════════════════════
//
// A user a frontend "📻 Internetrádió" tabján kiválaszt egy preset stream-et
// (vagy beír egyet), és az itt indul el a tenant snap-server-én. A klienseknek
// továbbra is a snap stream-en érkezik a hang – nincs kliens-oldali változás.

router.post("/play-stream", authJwt, requireTenant, async (req: Request, res: Response) => {
  try {
    if (!canWrite(role(req))) return res.status(403).json({ error: "Forbidden" });
    const { url, title, targetType = "ALL", targetId, streamVolume, durationSec, seekable } = req.body ?? {};
    if (!url || typeof url !== "string" || !url.trim()) {
      return res.status(400).json({ error: "url kötelező" });
    }
    if (!/^https?:\/\//i.test(url.trim())) {
      return res.status(400).json({ error: "url-nek http(s) URL-nek kell lennie" });
    }

    // streamVolume: 0..10 frontendről → dB-mapped live radio gain.
    // A live gain a TenantAudioMixer-en (`setRadioGain`) él, és a stream
    // közben is állítható (`PUT /radio/stream-volume`). Ezért NEM ffmpeg
    // pre-gain-en megy ki – itt csak az induló értéket állítjuk be.
    const sliderInit: number | null = (typeof streamVolume === "number"
      && streamVolume >= 0 && streamVolume <= 10)
      ? streamVolume
      : null;

    const { SnapcastService } = await import("../snapcast/snapcast.service");
    const { SyncEngine }      = await import("../../sync/SyncEngine");

    // Target eszközök meghatározása (a tenant minden online eszköze,
    // vagy a megadott device / group).
    let candidateIds: string[];
    if (targetType === "DEVICE" && targetId) {
      candidateIds = [String(targetId)];
    } else if (targetType === "GROUP" && targetId) {
      candidateIds = (await prisma.deviceGroupMember.findMany({
        where:  { groupId: String(targetId) },
        select: { deviceId: true },
      })).map(m => m.deviceId);
    } else {
      candidateIds = (await prisma.device.findMany({
        where:  { tenantId: tid(req), online: true },
        select: { id: true },
      })).map(d => d.id);
    }

    const snapOnline = await SnapcastService.isSnapserverOnline(tid(req));
    if (snapOnline) {
      // Auto-stop: ha bármi RADIO típusú forrás játszik (másik netrádió
      // vagy egy "play-now" fájl), azt SIGKILL-lel azonnal megszakítjuk,
      // és nem queue-ba tesszük az újat. A user-élmény: ▶ kattintásra
      // a régi rögtön némul, az új azonnal indul.
      // Live radio gain az induló slider-értékre (ha érkezett).
      if (sliderInit !== null) {
        await SnapcastService.setRadioVolume(tid(req), sliderInit);
      }

      await SnapcastService.stopRadio(tid(req));
      await SnapcastService.play({
        type:              "RADIO",
        /*
         * `seekable`: a hívó mondja meg, hogy véges, pozicionálható médiát
         * küld-e (YouTube fül → élő adás), vagy valódi, végtelen
         * internetrádió-adást. Ettől függ, hogy a seek-sáv tekerése és a
         * csengetés utáni folytatás a pozícióra ugrik-e, vagy a live
         * pozícióra csatlakozik vissza. Alapértelmezés: élő adás.
         */
        source:            { type: "stream", url: url.trim(), seekable: seekable === true },
        tenantId:          tid(req),
        title:             title?.trim() || "Internetrádió",
        durationSec:       typeof durationSec === "number" && isFinite(durationSec) ? durationSec : undefined,
        deviceIdsToUnmute: candidateIds,
        persistent:        true,
      });
    }

    // Online klienseknek SyncEngine broadcast (a kliens "PLAY_URL" action-t
    // ACK-ol, és a hangot a snap streamen át kapja).
    const onlineIds = candidateIds.filter(id => SyncEngine.isDeviceOnline(id));
    if (onlineIds.length > 0) {
      SyncEngine.dispatchSync({
        tenantId:        tid(req),
        commandId:       crypto.randomUUID(),
        action:          "PLAY_URL",
        kind:            "RADIO",
        url:             url.trim(),
        title:           title?.trim() || "Internetrádió",
        targetDeviceIds: candidateIds,
        snapcastActive:  snapOnline,
      }).catch(e => console.error("[RADIO/play-stream] SyncEngine hiba:", e));
    }

    return res.json({ ok: true, snapcastActive: snapOnline, targets: candidateIds.length });
  } catch (err: any) {
    console.error("[RADIO/play-stream] error:", err);
    return res.status(500).json({ error: err?.message || "Failed to start stream" });
  }
});

// PUT /radio/stream-volume – live radio hangerő-állítás stream közben.
// A frontend slider onChange-elése (debouncolt) hívja, és a változás
// azonnal érvényesül a következő PCM chunk-tól. A snapserver ~1 sec
// puffere miatt a klienseken kb. 1 másodperc késéssel hallható.
//
// Body: { value: 0..10 } (0 = mute, 10 = 0 dB max, 1 = -24 dB, lépésenként
//         ~-2.67 dB decibel-egyenletesen).
// GET /radio/stream-volume – az AKTUÁLIS rádió-hangerő (0..10).
//
// A kezelői felület belépéskor ezt kéri le, és ezt veszi át. Enélkül a
// böngészőben őrzött utolsó SAJÁT értékét küldte ki induláskor, és felülírta
// egy másik gépről beállított hangerőt: ha a laptopon 7-re állították, a
// telefonról belépve azonnal visszaugrott 10-re.
router.get("/stream-volume", authJwt, requireTenant, async (req: Request, res: Response) => {
  try {
    const { SnapcastService } = await import("../snapcast/snapcast.service");
    return res.json({ ok: true, value: SnapcastService.getRadioVolume(tid(req)) });
  } catch (err: any) {
    console.error("[RADIO/stream-volume GET] error:", err);
    return res.status(500).json({ error: "Failed to read stream volume" });
  }
});

router.put("/stream-volume", authJwt, requireTenant, async (req: Request, res: Response) => {
  try {
    if (!canWrite(role(req))) return res.status(403).json({ error: "Forbidden" });
    const { value } = req.body ?? {};
    if (typeof value !== "number" || !isFinite(value) || value < 0 || value > 10) {
      return res.status(400).json({ error: "value 0..10 szám kell legyen" });
    }
    const { SnapcastService } = await import("../snapcast/snapcast.service");
    await SnapcastService.setRadioVolume(tid(req), value);
    return res.json({ ok: true, value });
  } catch (err: any) {
    console.error("[RADIO/stream-volume] error:", err);
    return res.status(500).json({ error: err?.message || "Failed to set stream volume" });
  }
});

// POST /radio/files/:id/play-now – azonnali lejátszás egy meglévő RadioFile-ból
// (a frontend "Azonnali lejátszás" gombja ezt hívja, scheduling helyett).
router.post("/files/:id/play-now", authJwt, requireTenant, async (req: Request, res: Response) => {
  try {
    if (!canWrite(role(req))) return res.status(403).json({ error: "Forbidden" });
    const fileId = paramId(req);
    const { targetType = "ALL", targetId, streamVolume } = req.body ?? {};
    // streamVolume: 0..10 frontendről → induló live radio gain.
    // A futás közbeni állítás a `PUT /radio/stream-volume` endpoint-on át megy.
    const sliderInit: number | null = (typeof streamVolume === "number"
      && streamVolume >= 0 && streamVolume <= 10)
      ? streamVolume
      : null;

    const file = await prisma.radioFile.findFirst({
      where:  { id: fileId, tenantId: tid(req) },
      select: { id: true, fileUrl: true, originalName: true, durationSec: true },
    });
    if (!file) return res.status(404).json({ error: "RadioFile nem található" });

    const { SnapcastService } = await import("../snapcast/snapcast.service");
    const { SyncEngine }      = await import("../../sync/SyncEngine");

    let candidateIds: string[];
    if (targetType === "DEVICE" && targetId) {
      candidateIds = [String(targetId)];
    } else if (targetType === "GROUP" && targetId) {
      candidateIds = (await prisma.deviceGroupMember.findMany({
        where:  { groupId: String(targetId) },
        select: { deviceId: true },
      })).map(m => m.deviceId);
    } else {
      candidateIds = (await prisma.device.findMany({
        where:  { tenantId: tid(req), online: true },
        select: { id: true },
      })).map(d => d.id);
    }

    const snapOnline = await SnapcastService.isSnapserverOnline(tid(req));
    if (snapOnline) {
      // Live radio gain az induló slider-értékre (ha érkezett).
      if (sliderInit !== null) {
        await SnapcastService.setRadioVolume(tid(req), sliderInit);
      }

      // Auto-stop: ha bármi RADIO forrás (netrádió vagy másik play-now)
      // szól, azt azonnal megszakítjuk, és nem queue-ba tesszük az újat.
      await SnapcastService.stopRadio(tid(req));
      await SnapcastService.play({
        type:              "RADIO",
        source:            { type: "url", url: rehostUrl(file.fileUrl) },
        tenantId:          tid(req),
        title:             file.originalName,
        durationSec:       file.durationSec ?? undefined,
        deviceIdsToUnmute: candidateIds,
      });
    }
    const onlineIds = candidateIds.filter(id => SyncEngine.isDeviceOnline(id));
    if (onlineIds.length > 0) {
      SyncEngine.dispatchSync({
        tenantId:        tid(req),
        commandId:       crypto.randomUUID(),
        action:          "PLAY_URL",
        kind:            "RADIO",
        url:             file.fileUrl,
        title:           file.originalName,
        durationMs:      file.durationSec ? file.durationSec * 1000 : undefined,
        targetDeviceIds: candidateIds,
        snapcastActive:  snapOnline,
      }).catch(e => console.error("[RADIO/play-now] SyncEngine hiba:", e));
    }
    return res.json({ ok: true, snapcastActive: snapOnline, targets: candidateIds.length });
  } catch (err: any) {
    console.error("[RADIO/play-now] error:", err);
    return res.status(500).json({ error: err?.message || "Failed to play file" });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// ÉLŐ LEJÁTSZÁS-VEZÉRLÉS (seek/pause/resume/status) – YouTube fül élő adásba
// küldött videója, ill. Hangfájl könyvtár élő seek-sávja. Csak akkor hat,
// ha ÉPP egy RADIO típusú job aktívan szól (vagy user által szüneteltetve
// van) – ld. audio-mixer.ts `seekRadio`/`pauseRadio`/`resumeRadio`/
// `getRadioLiveState` kommentjeit a pontos szemantikáért.
// ═══════════════════════════════════════════════════════════════════════════

router.post("/live/seek", authJwt, requireTenant, async (req: Request, res: Response) => {
  try {
    if (!canWrite(role(req))) return res.status(403).json({ error: "Forbidden" });
    const { positionSec } = req.body ?? {};
    if (typeof positionSec !== "number" || !isFinite(positionSec) || positionSec < 0) {
      return res.status(400).json({ error: "positionSec kötelező, nem-negatív szám" });
    }
    const { SnapcastService } = await import("../snapcast/snapcast.service");
    const ok = SnapcastService.seekRadio(tid(req), positionSec);
    if (!ok) return res.status(409).json({ error: "Nincs éppen élő rádió-lejátszás" });
    return res.json({ ok: true });
  } catch (err) { console.error("[RADIO/live/seek]", err); return res.status(500).json({ error: "Failed to seek" }); }
});

router.post("/live/pause", authJwt, requireTenant, async (req: Request, res: Response) => {
  try {
    if (!canWrite(role(req))) return res.status(403).json({ error: "Forbidden" });
    const { SnapcastService } = await import("../snapcast/snapcast.service");
    const ok = SnapcastService.pauseRadio(tid(req));
    if (!ok) return res.status(409).json({ error: "Nincs éppen élő rádió-lejátszás" });
    return res.json({ ok: true });
  } catch (err) { console.error("[RADIO/live/pause]", err); return res.status(500).json({ error: "Failed to pause" }); }
});

router.post("/live/resume", authJwt, requireTenant, async (req: Request, res: Response) => {
  try {
    if (!canWrite(role(req))) return res.status(403).json({ error: "Forbidden" });
    const { SnapcastService } = await import("../snapcast/snapcast.service");
    const ok = SnapcastService.resumeRadio(tid(req));
    if (!ok) return res.status(409).json({ error: "Nincs szüneteltetett élő lejátszás" });
    return res.json({ ok: true });
  } catch (err) { console.error("[RADIO/live/resume]", err); return res.status(500).json({ error: "Failed to resume" }); }
});

// GET /radio/live/status – a frontend LiveProgressBar 1mp-enként pollozza
// (nem canWrite-hoz kötött, csak olvasás – a `/ytplaylists/:id/status`
// mintáját követve).
router.get("/live/status", authJwt, requireTenant, async (req: Request, res: Response) => {
  try {
    const { SnapcastService } = await import("../snapcast/snapcast.service");
    const state = SnapcastService.getRadioLiveState(tid(req));
    return res.json({ ok: true, state });
  } catch (err) { console.error("[RADIO/live/status]", err); return res.status(500).json({ error: "Failed to fetch live status" }); }
});

// ═══════════════════════════════════════════════════════════════════════════
// YOUTUBE – IDŐZÍTETT LEJÁTSZÁS
// ═══════════════════════════════════════════════════════════════════════════
//
// A yt-dlp-vel kinyert közvetlen CDN-URL (`/yt-live-url`) lejáró, aláírt
// link – nem alkalmas órákkal/napokkal későbbre időzítésre. Ezért időzítéskor
// a MEGLÉVŐ letöltési pipeline-t használjuk (mint a `buildYoutubePlaylist`):
// előbb letöltjük+tároljuk MP3-ként egy normál RadioFile rekordként, majd a
// fenti `createSchedule()` helperrel egy szokványos ütemezést hozunk létre
// rá – nincs új adatmodell, és az időzített pillanatban a fájl már helyben
// van (nem függ egy időközben lejárt YouTube-linktől).
router.post("/youtube/schedule", authJwt, requireTenant, async (req: Request, res: Response) => {
  try {
    if (!canWrite(role(req))) return res.status(403).json({ error: "Forbidden" });
    const { url, title, targetType, targetId, scheduledAt, endsAt, startSec } = req.body ?? {};
    if (!url || typeof url !== "string" || !isYoutubeUrl(url)) {
      return res.status(400).json({ error: "Érvényes YouTube URL szükséges" });
    }
    if (!targetType || !scheduledAt) return res.status(400).json({ error: "targetType and scheduledAt are required" });
    const scheduledDate = new Date(scheduledAt);
    if (isNaN(scheduledDate.getTime())) return res.status(400).json({ error: "Invalid scheduledAt date" });
    if (scheduledDate < new Date())     return res.status(400).json({ error: "scheduledAt must be in the future" });

    let endsAtDate: Date | null = null;
    if (endsAt) {
      endsAtDate = new Date(endsAt);
      if (isNaN(endsAtDate.getTime())) return res.status(400).json({ error: "Invalid endsAt date" });
      if (endsAtDate <= scheduledDate) return res.status(400).json({ error: "endsAt must be after scheduledAt" });
    }

    /*
     * INDULÁSI POZÍCIÓ.
     *
     * A yt-dlp az EGÉSZ videót szedi le; a kezdőpontra utólag vágunk rá
     * ffmpeg-gel. Szándékosan újrakódolunk (nem `-c copy`): a másolás csak
     * frame-határra tud vágni, tehát a megadott másodperctől néhány tized
     * eltérés lenne, és egyes lejátszók az így keletkező csonka első frame-en
     * kattannak. A kimenet a rendszer egységes formátuma (Opus 96k).
     */
    const startAt = Number(startSec);
    const startOffsetSec = Number.isFinite(startAt) && startAt > 0 ? Math.floor(startAt) : 0;

    const hash    = crypto.randomBytes(12).toString("hex");
    const outTmpl = path.join(RADIO_UPLOAD_DIR, `radio_yt_${hash}.%(ext)s`);
    await runCmd(YT_DLP_BIN, [...ytDlpAudioArgs(), "--no-playlist", "--output", outTmpl, "--no-warnings", url.trim()]);

    const filename   = `radio_yt_${hash}${AUDIO_EXT}`;
    const outputPath = path.join(RADIO_UPLOAD_DIR, filename);
    if (!fs.existsSync(outputPath)) return res.status(422).json({ error: "A videó letöltése sikertelen" });

    if (startOffsetSec > 0) {
      const trimmedPath = path.join(RADIO_UPLOAD_DIR, `radio_yt_${hash}_from${AUDIO_EXT}`);
      await runCmd("ffmpeg", ["-y", "-ss", String(startOffsetSec), "-i", outputPath,
                              ...opusOutputArgs(), trimmedPath]);
      if (!fs.existsSync(trimmedPath) || fs.statSync(trimmedPath).size === 0) {
        // Ha a vágás nem sikerült, NEM buktatjuk el az ütemezést: a videó
        // elejéről induló változat még mindig jobb, mint a néma semmi.
        console.warn(`[youtube/schedule] a startpozíció-vágás nem sikerült (${startOffsetSec}s) – marad az eleje`);
        try { fs.unlinkSync(trimmedPath); } catch {}
      } else {
        fs.renameSync(trimmedPath, outputPath);
      }
    }

    const sizeBytes   = fs.statSync(outputPath).size;
    const durationSec = await getAudioDurationSec(outputPath);
    const fileUrl     = `${baseUrl()}/uploads/radio/${filename}`;
    const radioFile   = await prisma.radioFile.create({
      data: {
        tenantId: tid(req), filename,
        originalName: `${(typeof title === "string" && title.trim()) || "YouTube videó"}` +
                      `${startOffsetSec > 0 ? ` (${fmtHms(startOffsetSec)}-tól)` : ""}${AUDIO_EXT}`,
        sizeBytes, durationSec, fileUrl, createdById: uid(req),
      },
    });

    const result = await createSchedule({
      tid: tid(req), uid: uid(req), radioFileId: radioFile.id,
      targetType, targetId, scheduledAt: scheduledDate, endsAt: endsAtDate,
    });
    if (!result.ok) return res.status(result.status).json({ error: result.error, conflict: (result as any).conflict });
    return res.status(201).json({ ok: true, schedule: result.schedule, radioFile });
  } catch (err: any) {
    console.error("[youtube/schedule]", err?.message);
    return res.status(500).json({ error: "Failed to schedule YouTube video" });
  }
});
// ═══════════════════════════════════════════════════════════════════════════
// INTERNETRÁDIÓ – IDŐZÍTETT LEJÁTSZÁS
// ═══════════════════════════════════════════════════════════════════════════
//
// A `/play-stream` azonnal indít; ez ugyanazt ütemezi egy jövőbeli időpontra.
// Fájl NEM készül: az állomás élő stream, a lejátszáskor a snap-mixer
// közvetlenül a `streamUrl`-t húzza (ld. radio.scheduler.ts).
//
// Az állomáslista a böngészőben él (tenant-onkénti localStorage), ezért az
// URL-t és a nevet a kliens küldi – itt validáljuk.
router.post("/stations/schedule", authJwt, requireTenant, async (req: Request, res: Response) => {
  try {
    if (!canWrite(role(req))) return res.status(403).json({ error: "Forbidden" });
    const { url, title, targetType, targetId, scheduledAt, endsAt } = req.body ?? {};

    if (!url || typeof url !== "string" || !/^https?:\/\//i.test(url.trim())) {
      return res.status(400).json({ error: "Érvényes http(s) stream URL szükséges" });
    }
    if (!targetType || !scheduledAt) {
      return res.status(400).json({ error: "targetType and scheduledAt are required" });
    }
    const scheduledDate = new Date(scheduledAt);
    if (isNaN(scheduledDate.getTime())) return res.status(400).json({ error: "Invalid scheduledAt date" });
    if (scheduledDate < new Date())     return res.status(400).json({ error: "scheduledAt must be in the future" });

    let endsAtDate: Date | null = null;
    if (endsAt) {
      endsAtDate = new Date(endsAt);
      if (isNaN(endsAtDate.getTime())) return res.status(400).json({ error: "Invalid endsAt date" });
      if (endsAtDate <= scheduledDate) return res.status(400).json({ error: "endsAt must be after scheduledAt" });
    }

    const result = await createSchedule({
      tid: tid(req), uid: uid(req),
      streamUrl:   url.trim(),
      streamTitle: typeof title === "string" ? title : null,
      targetType, targetId, scheduledAt: scheduledDate, endsAt: endsAtDate,
    });
    if (!result.ok) return res.status(result.status).json({ error: result.error, conflict: (result as any).conflict });
    return res.status(201).json({ ok: true, schedule: result.schedule });
  } catch (err: any) {
    console.error("[stations/schedule]", err?.message);
    return res.status(500).json({ error: "Failed to schedule internet radio" });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// MONITOROZÁS – a kezelői felület snap-kliensének feloldása
// ═══════════════════════════════════════════════════════════════════════════
//
// A monitor (ld. frontend `MonitorPill.tsx`) külön snap-kliensként csatlakozik,
// hogy a kezelő a saját gépén hallja a TELJES kevert kimenetet. Célzott
// eszköznek sosem számít, ezért egy korábbi célzás némán ottfelejthette
// némítva – a snapserver pedig a némított kliensnek egyetlen hangcsomagot sem
// küld. Ezt oldja fel a kliens csatlakozásakor.
router.post("/monitor/unmute", authJwt, requireTenant, async (req: Request, res: Response) => {
  try {
    const { clientId } = req.body ?? {};
    if (typeof clientId !== "string" || !clientId) {
      return res.status(400).json({ error: "clientId kötelező" });
    }
    const { SnapcastService, isMonitorClient } = await import("../snapcast/snapcast.service");
    // Csak monitor-klienst enged feloldani: egy valódi eszköz némítása a
    // célzás dolga, azt innen felülírni targeting-kerülő út lenne.
    if (!isMonitorClient(clientId)) {
      return res.status(400).json({ error: "csak monitor-kliens oldható fel" });
    }
    const ok = await SnapcastService.unmuteMonitorClient(tid(req), clientId);
    return res.json({ ok });
  } catch (err: any) {
    console.error("[monitor/unmute]", err?.message);
    return res.status(500).json({ error: "Failed to unmute monitor client" });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// YOUTUBE → HANGFÁJL KÖNYVTÁR
// ═══════════════════════════════════════════════════════════════════════════
//
// A videó hangját letölti és RadioFile-ként eltárolja – ütemezés NÉLKÜL.
// A `/youtube/schedule` ugyanezt csinálja, de utána időzítést is létrehoz;
// a YouTube fül „Letöltés a hangtárba" gombjának viszont csak a fájl kell,
// hogy onnantól bármikor lejátszható és ütemezhető legyen.
router.post("/youtube/download", authJwt, requireTenant, async (req: Request, res: Response) => {
  try {
    if (!canWrite(role(req))) return res.status(403).json({ error: "Forbidden" });
    const { url, title, startSec } = req.body ?? {};
    if (!url || typeof url !== "string" || !isYoutubeUrl(url)) {
      return res.status(400).json({ error: "Érvényes YouTube URL szükséges" });
    }

    const startAt = Number(startSec);
    const startOffsetSec = Number.isFinite(startAt) && startAt > 0 ? Math.floor(startAt) : 0;

    pruneYtDownloadJobs();
    const jobId    = crypto.randomBytes(9).toString("hex");
    const tenantId = tid(req);
    const userId   = uid(req);
    ytDownloadJobs.set(jobId, { tenantId, status: "RUNNING", percent: 0, startedAt: Date.now() });

    // A választ AZONNAL elküldjük; a munka a háttérben fut tovább.
    res.status(202).json({ ok: true, jobId });

    void (async () => {
      const setJob = (patch: Partial<YtDownloadJob>) => {
        const cur = ytDownloadJobs.get(jobId);
        if (cur) ytDownloadJobs.set(jobId, { ...cur, ...patch });
      };
      try {
        const hash    = crypto.randomBytes(12).toString("hex");
        const outTmpl = path.join(RADIO_UPLOAD_DIR, `radio_yt_${hash}.%(ext)s`);

        /*
         * A letöltés a 0–90%-os sávot kapja, a maradékot az átkódolás és a
         * vágás. Így a csík nem áll 100%-on percekig, amíg az ffmpeg dolgozik.
         */
        await runCmdProgress(
          YT_DLP_BIN,
          ["--newline", ...ytDlpAudioArgs(),
           "--no-playlist", "--output", outTmpl, "--no-warnings", url.trim()],
          (pct) => setJob({ percent: Math.round(pct * 0.9) }),
        );

        const filename   = `radio_yt_${hash}${AUDIO_EXT}`;
        const outputPath = path.join(RADIO_UPLOAD_DIR, filename);
        if (!fs.existsSync(outputPath)) throw new Error("A videó letöltése sikertelen");

        setJob({ percent: 92 });

        if (startOffsetSec > 0) {
          const trimmedPath = path.join(RADIO_UPLOAD_DIR, `radio_yt_${hash}_from${AUDIO_EXT}`);
          await runCmd("ffmpeg", ["-y", "-ss", String(startOffsetSec), "-i", outputPath,
                                  ...opusOutputArgs(), trimmedPath]);
          if (!fs.existsSync(trimmedPath) || fs.statSync(trimmedPath).size === 0) {
            console.warn(`[youtube/download] a startpozíció-vágás nem sikerült (${startOffsetSec}s) – marad az eleje`);
            try { fs.unlinkSync(trimmedPath); } catch {}
          } else {
            fs.renameSync(trimmedPath, outputPath);
          }
        }

        setJob({ percent: 97 });

        const sizeBytes   = fs.statSync(outputPath).size;
        const durationSec = await getAudioDurationSec(outputPath);
        const fileUrl     = `${baseUrl()}/uploads/radio/${filename}`;
        const radioFile   = await prisma.radioFile.create({
          data: {
            tenantId, filename,
            originalName: `${(typeof title === "string" && title.trim()) || "YouTube videó"}` +
                          `${startOffsetSec > 0 ? ` (${fmtHms(startOffsetSec)}-tól)` : ""}${AUDIO_EXT}`,
            sizeBytes, durationSec, fileUrl, createdById: userId,
          },
        });

        setJob({ status: "DONE", percent: 100, radioFile });
        console.log(`[youtube/download] kész: ${radioFile.originalName} (${sizeBytes} B)`);
      } catch (err: any) {
        console.error("[youtube/download]", err?.message);
        setJob({ status: "ERROR", error: err?.message ?? "Letöltés sikertelen" });
      }
    })();
  } catch (err: any) {
    console.error("[youtube/download start]", err?.message);
    if (!res.headersSent) return res.status(500).json({ error: "Failed to start download" });
  }
});

// GET /radio/youtube/download-status/:jobId – a háttérletöltés állapota.
router.get("/youtube/download-status/:jobId", authJwt, requireTenant, async (req: Request, res: Response) => {
  const job = ytDownloadJobs.get(String(req.params.jobId));
  if (!job) return res.status(404).json({ error: "Ismeretlen letöltés" });
  // Más intézmény feladatának állapota nem szivároghat ki.
  if (job.tenantId !== tid(req)) return res.status(404).json({ error: "Ismeretlen letöltés" });
  return res.json({
    ok: true, status: job.status, percent: job.percent,
    ...(job.error ? { error: job.error } : {}),
    ...(job.radioFile ? { radioFile: job.radioFile } : {}),
  });
});

// src/modules/firmware/firmware.routes.ts
// ─────────────────────────────────────────────────────────────────────────────
// Endpoints:
//   POST /firmware/upload          – Admin: firmware .bin feltöltése
//   GET  /firmware/releases        – Admin: verziólista
//   GET  /firmware/check           – ESP32: van-e újabb verzió?
//   POST /firmware/ota-status      – ESP32: frissítési állapot visszajelzés
//   DELETE /firmware/releases/:id  – Admin: verzió törlése
// ─────────────────────────────────────────────────────────────────────────────
import { Router, Request, Response } from "express";
import multer from "multer";
import path   from "path";
import fs     from "fs";
import crypto from "crypto";
import { prisma }        from "../../prisma/client";
import { authJwt }       from "../../middleware/authJwt";
import { requireTenant } from "../../middleware/tenant";

const router = Router();

// Firmware fájlok tárolása
const FIRMWARE_DIR = path.join(process.cwd(), "uploads", "firmware");
if (!fs.existsSync(FIRMWARE_DIR)) fs.mkdirSync(FIRMWARE_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, FIRMWARE_DIR),
  filename:    (_req, file, cb) => {
    const safe = String(file.originalname).replace(/[^a-zA-Z0-9._-]/g, "_");
    cb(null, safe);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 4 * 1024 * 1024 },  // max 4MB
  fileFilter: (_req, file, cb) => {
    if (file.originalname.endsWith(".bin")) cb(null, true);
    else cb(new Error("Csak .bin fájl fogadható el"));
  },
});

function userId(req: Request): string  { return (req as any).user?.sub as string; }
function userRole(req: Request): string { return (req as any).user?.role as string; }
function tenantId(req: Request): string { return (req as any).tenantId as string; }

// ── POST /firmware/upload ─────────────────────────────────────────────────────
router.post("/upload", authJwt, requireTenant, upload.single("file"),
  async (req: Request, res: Response) => {
    try {
      const role = userRole(req);
      if (role !== "SUPER_ADMIN" && role !== "TENANT_ADMIN") {
        return res.status(403).json({ error: "Csak admin tölthet fel firmware-t" });
      }

      if (!req.file) return res.status(400).json({ error: "Fájl kötelező" });

      const { version, notes, mandatory, targetClass } = req.body;
      if (!version?.trim()) return res.status(400).json({ error: "version kötelező" });

      // SHA-256 hash kiszámítása
      const fileBuffer = fs.readFileSync(req.file.path);
      const sha256 = crypto.createHash("sha256").update(fileBuffer).digest("hex");
      const fileUrl = `${process.env.BASE_URL ?? "https://api.schoollive.hu"}/firmware/files/${req.file.filename}`;

      const release = await prisma.firmwareRelease.create({
        data: {
          version:     version.trim(),
          filename:    req.file.filename,
          fileUrl,
          sizeBytes:   req.file.size,
          sha256,
          notes:       notes ?? null,
          mandatory:   mandatory === "true" || mandatory === true,
          targetClass: targetClass ?? "ALL",
          createdById: userId(req),
        },
      });

      console.log(`[OTA] Firmware feltöltve: ${version} (${req.file.size} bytes)`);
      return res.status(201).json({ ok: true, release });
    } catch (e: any) {
      if (e.code === "P2002") return res.status(409).json({ error: "Ez a verzió már létezik" });
      console.error(e);
      return res.status(500).json({ error: "Feltöltés sikertelen" });
    }
  }
);

// ── GET /firmware/files/:filename – statikus .bin kiszolgálás ─────────────────
router.get("/files/:filename", async (req: Request, res: Response) => {
  // Device key auth vagy admin JWT
  const filename = (Array.isArray(req.params.filename) ? req.params.filename[0] : req.params.filename).replace(/[^a-zA-Z0-9._-]/g, "_");
  const filePath = path.join(FIRMWARE_DIR, filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: "Nem található" });
  res.setHeader("Content-Type", "application/octet-stream");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  return res.sendFile(filePath);
});

// ── GET /firmware/releases – verziólista (admin) ──────────────────────────────
router.get("/releases", authJwt, requireTenant, async (req: Request, res: Response) => {
  try {
    const releases = await prisma.firmwareRelease.findMany({
      orderBy: { createdAt: "desc" },
      include: { createdBy: { select: { email: true, displayName: true } } },
    });
    return res.json({ ok: true, releases });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Lekérés sikertelen" });
  }
});

// ── GET /firmware/check – ESP32 verzióellenőrzés ──────────────────────────────
// Header: x-device-key
// Query:  ?version=S3.4&deviceClass=SPEAKER
router.get("/check", async (req: Request, res: Response) => {
  try {
    const deviceKey   = Array.isArray(req.headers["x-device-key"]) ? req.headers["x-device-key"][0] : req.headers["x-device-key"] as string | undefined;
    const curVersion  = req.query.version     as string ?? "";
    const deviceClass = req.query.deviceClass as string ?? "SPEAKER";

    if (!deviceKey) return res.status(401).json({ error: "x-device-key kötelező" });
    const safeKey = deviceKey as string;

    // Eszköz azonosítása
    const keyHash = crypto.createHash("sha256").update(safeKey).digest("hex");
    // bcrypt a szkémában – keressük az összes eszközt (kis szám)
    const bcrypt = require("bcrypt");
    const devices = await prisma.device.findMany({
      where:  { deviceKeyHash: { not: null } },
      select: { id: true, tenantId: true, deviceKeyHash: true },
    });
    let device: { id: string; tenantId: string } | null = null;
    for (const d of devices) {
      if (!d.deviceKeyHash) continue;
      if (await bcrypt.compare(safeKey, d.deviceKeyHash)) { device = d; break; }
    }
    if (!device) return res.status(401).json({ error: "Ismeretlen eszköz" });

    // Legújabb kompatibilis firmware lekérése
    const latest = await prisma.firmwareRelease.findFirst({
      where: {
        OR: [
          { targetClass: "ALL" },
          { targetClass: deviceClass },
        ],
      },
      orderBy: { createdAt: "desc" },
      select: {
        id: true, version: true, fileUrl: true,
        sizeBytes: true, sha256: true, mandatory: true, notes: true,
      },
    });

    if (!latest) return res.json({ ok: true, updateAvailable: false });

    const updateAvailable = latest.version !== curVersion;

    // OTA státusz frissítése az eszközön
    if (updateAvailable) {
      await (prisma.device as any).update({
        where: { id: device.id },
        data:  { otaStatus: "PENDING", otaVersion: latest.version },
      }).catch(() => {});
    }

    return res.json({
      ok: true,
      updateAvailable,
      current:  curVersion,
      latest: updateAvailable ? {
        version:   latest.version,
        url:       latest.fileUrl,
        sizeBytes: latest.sizeBytes,
        sha256:    latest.sha256,
        mandatory: latest.mandatory,
        notes:     latest.notes,
      } : null,
    });
  } catch (e) {
    console.error("[OTA] check hiba:", e);
    return res.status(500).json({ error: "Ellenőrzés sikertelen" });
  }
});

// ── POST /firmware/ota-status – ESP32 visszajelzés ───────────────────────────
// Body: { version, status: "DOWNLOADING"|"INSTALLING"|"SUCCESS"|"FAILED"|"ROLLBACK", progress?, error? }
router.post("/ota-status", async (req: Request, res: Response) => {
  try {
    const deviceKey = Array.isArray(req.headers["x-device-key"]) ? req.headers["x-device-key"][0] : req.headers["x-device-key"] as string | undefined;
    if (!deviceKey) return res.status(401).json({ error: "x-device-key kötelező" });
    const safeKey2 = deviceKey as string;

    const { version, status, progress, error: errMsg } = req.body;

    const bcrypt  = require("bcrypt");
    const devices = await prisma.device.findMany({
      where:  { deviceKeyHash: { not: null } },
      select: { id: true, deviceKeyHash: true },
    });
    let deviceId: string | null = null;
    for (const d of devices) {
      if (!d.deviceKeyHash) continue;
      if (await bcrypt.compare(safeKey2, d.deviceKeyHash)) { deviceId = d.id; break; }
    }
    if (!deviceId) return res.status(401).json({ error: "Ismeretlen eszköz" });

    const otaStatus =
      status === "SUCCESS"    ? "UP_TO_DATE"  :
      status === "FAILED"     ? "FAILED"      :
      status === "ROLLBACK"   ? "ROLLBACK"    :
      status === "INSTALLING" ? "INSTALLING"  :
      status === "DOWNLOADING"? "DOWNLOADING" : "PENDING";

    await (prisma.device as any).update({
      where: { id: deviceId },
      data: {
        otaStatus,
        otaProgress:  progress ?? 0,
        otaVersion:   status === "SUCCESS" ? version : undefined,
        otaUpdatedAt: new Date(),
        ...(status === "SUCCESS" ? { firmwareVersion: version } : {}),
      },
    }).catch(() => {});

    console.log(`[OTA] ${deviceId}: ${status} v${version} progress=${progress ?? "-"}`);
    return res.json({ ok: true });
  } catch (e) {
    console.error("[OTA] status hiba:", e);
    return res.status(500).json({ error: "Státusz frissítés sikertelen" });
  }
});

// ── DELETE /firmware/releases/:id ────────────────────────────────────────────
router.delete("/releases/:id", authJwt, requireTenant, async (req: Request, res: Response) => {
  try {
    const role = userRole(req);
    if (role !== "SUPER_ADMIN" && role !== "TENANT_ADMIN") {
      return res.status(403).json({ error: "Csak admin törölhet" });
    }
    const release = await prisma.firmwareRelease.findUnique({
      where: { id: Array.isArray(req.params.id) ? req.params.id[0] : req.params.id },
    });
    if (!release) return res.status(404).json({ error: "Nem található" });

    // Fájl törlése
    const filePath = path.join(FIRMWARE_DIR, release.filename);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

    await prisma.firmwareRelease.delete({ where: { id: Array.isArray(req.params.id) ? req.params.id[0] : req.params.id } });
    return res.json({ ok: true });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Törlés sikertelen" });
  }
});

export default router;
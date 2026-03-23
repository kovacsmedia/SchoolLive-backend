// src/modules/devices/devices.native.routes.ts
//
// Native player provisioning – JWT nélkül, MAC alapú hardwareId + client-oldali deviceKey
//
// Változások:
//   • GET /info      → deviceId mezőt is visszaadja (targeting-hez szükséges)
//   • POST /beacon   → deviceId visszaadva a válaszban (kliens cachelti)
//   • GET /snap-port → változatlan

import { Router, Request, Response } from "express";
import { prisma }                    from "../../prisma/client";
import { randomBytes }               from "crypto";

const router = Router();

const pendingKeyHashes = new Map<string, string>();

// ── POST /devices/native/provision ────────────────────────────────────────────
router.post("/provision", async (req: Request, res: Response) => {
  try {
    const {
      hardwareId,
      deviceKeyHash,
      shortId,
      platform,
      version,
      userAgent,
    } = req.body ?? {};

    if (!hardwareId || !deviceKeyHash || !shortId) {
      return res.status(400).json({ error: "hardwareId, deviceKeyHash és shortId kötelező" });
    }

    const ipAddress = (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim()
      ?? req.socket.remoteAddress
      ?? null;

    // Aktív eszköz?
    const activeDevice = await prisma.device.findFirst({
      where:  { serialNumber: hardwareId, authType: "KEY" },
      select: { id: true, tenantId: true },
    });

    if (activeDevice) {
      // deviceId visszaadva – kliens cachelti a targetinghez
      return res.json({ status: "active", deviceId: activeDevice.id });
    }

    // Pending frissítés
    const existing = await prisma.pendingDevice.findFirst({ where: { mac: hardwareId } });

    if (existing) {
      await prisma.pendingDevice.update({
        where: { id: existing.id },
        data: {
          lastSeenAt: new Date(),
          ipAddress:  ipAddress ?? existing.ipAddress,
          userAgent:  userAgent ?? existing.userAgent,
        },
      });
      pendingKeyHashes.set(shortId, deviceKeyHash);
      return res.json({ status: "pending", shortId });
    }

    // Új pending
    await prisma.pendingDevice.create({
      data: {
        mac:         hardwareId,
        clientId:    shortId,
        ipAddress,
        userAgent:   `${platform ?? "native"}/${version ?? "?"}${userAgent ? ` | ${userAgent}` : ""}`,
        firstSeenAt: new Date(),
        lastSeenAt:  new Date(),
      },
    });

    pendingKeyHashes.set(shortId, deviceKeyHash);

    console.log(`[NativeProvision] Új pending native player: ${shortId} (${platform}) ip=${ipAddress}`);
    return res.json({ status: "pending", shortId });

  } catch (err) {
    console.error("[NativeProvision] hiba:", err);
    return res.status(500).json({ error: "Provisioning hiba" });
  }
});

// ── GET /devices/native/status/:hardwareId ────────────────────────────────────
router.get("/status/:hardwareId", async (req: Request, res: Response) => {
  try {
    const hardwareId = String(req.params.hardwareId);

    const activeDevice = await prisma.device.findFirst({
      where:  { serialNumber: hardwareId, authType: "KEY" },
      select: { id: true },
    });

    if (activeDevice) {
      // deviceId visszaadva – kliens cachelti a targetinghez
      return res.json({ status: "active", deviceId: activeDevice.id });
    }
    return res.json({ status: "pending" });
  } catch (err) {
    console.error("[NativeProvision] status hiba:", err);
    return res.status(500).json({ error: "Status lekérdezés hiba" });
  }
});

// ── GET /devices/native/info ──────────────────────────────────────────────────
// Változás: deviceId is visszaadva (targeting-hez szükséges a Python playernek)
router.get("/info", async (req: Request, res: Response) => {
  try {
    const deviceKey = req.headers["x-device-key"] as string;
    if (!deviceKey) return res.status(400).json({ error: "x-device-key required" });

    const bcrypt  = await import("bcrypt");
    const devices = await prisma.device.findMany({
      where:  { deviceKeyHash: { not: null }, authType: "KEY" },
      select: {
        id:            true,
        deviceKeyHash: true,
        tenant: { select: { name: true } },
      },
    });

    let matchedId:   string | null = null;
    let tenantName:  string | null = null;

    for (const d of devices) {
      if (!d.deviceKeyHash) continue;
      const ok = await bcrypt.compare(deviceKey, d.deviceKeyHash);
      if (ok) {
        matchedId  = d.id;
        tenantName = d.tenant?.name ?? null;
        break;
      }
    }

    if (!matchedId) return res.status(401).json({ error: "Invalid device key" });

    // deviceId most már benne van a válaszban!
    return res.json({ ok: true, tenantName, deviceId: matchedId });

  } catch (err) {
    console.error("[NativeInfo] hiba:", err);
    return res.status(500).json({ error: "Info hiba" });
  }
});

// ── POST /devices/native/beacon ───────────────────────────────────────────────
// Változás: deviceId visszaadva a válaszban
router.post("/beacon", async (req: Request, res: Response) => {
  try {
    const deviceKey = req.headers["x-device-key"] as string;
    if (!deviceKey) return res.status(400).json({ error: "x-device-key header required" });

    const bcrypt  = await import("bcrypt");
    const devices = await prisma.device.findMany({
      where:  { deviceKeyHash: { not: null }, authType: "KEY" },
      select: { id: true, deviceKeyHash: true },
    });

    let deviceId: string | null = null;
    for (const d of devices) {
      if (!d.deviceKeyHash) continue;
      const ok = await bcrypt.compare(deviceKey, d.deviceKeyHash);
      if (ok) { deviceId = d.id; break; }
    }

    if (!deviceId) return res.status(401).json({ error: "Invalid device key" });

    const ipAddress = (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim()
      ?? req.socket.remoteAddress ?? null;

    await prisma.device.update({
      where: { id: deviceId },
      data: {
        online:     true,
        lastSeenAt: new Date(),
        ipAddress:  ipAddress ?? undefined,
      },
    });

    // deviceId visszaadva – kliens cachelti ha még nincs meg
    return res.json({ ok: true, deviceId });

  } catch (err) {
    console.error("[NativeBeacon] hiba:", err);
    return res.status(500).json({ error: "Beacon hiba" });
  }
});

// ── GET /devices/native/snap-port ─────────────────────────────────────────────
router.get("/snap-port", async (req: Request, res: Response) => {
  try {
    const deviceKey = req.headers["x-device-key"] as string;
    if (!deviceKey) return res.status(400).json({ error: "x-device-key kötelező" });

    const bcrypt  = await import("bcrypt");
    const devices = await prisma.device.findMany({
      where:  { deviceKeyHash: { not: null }, authType: "KEY" },
      select: { id: true, deviceKeyHash: true, tenantId: true },
    });

    let tenantId: string | null = null;
    for (const d of devices) {
      if (!d.deviceKeyHash) continue;
      if (await bcrypt.compare(deviceKey, d.deviceKeyHash)) {
        tenantId = d.tenantId; break;
      }
    }

    if (!tenantId) return res.status(401).json({ error: "Ismeretlen eszköz" });

    const tenant = await prisma.tenant.findUnique({
      where:  { id: tenantId },
      select: { snapPort: true },
    });

    if (!tenant?.snapPort) {
      return res.status(404).json({ error: "Nincs snapPort beállítva" });
    }

    console.log(`[NativeSnapPort] tenantId=${tenantId} snapPort=${tenant.snapPort}`);
    return res.json({ ok: true, snapPort: tenant.snapPort });

  } catch (err) {
    console.error("[NativeSnapPort] hiba:", err);
    return res.status(500).json({ error: "SnapPort lekérdezés hiba" });
  }
});

export { pendingKeyHashes };
export default router;
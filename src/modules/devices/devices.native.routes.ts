// src/modules/devices/devices.native.routes.ts
//
// Native player provisioning – JWT nélkül, MAC alapú hardwareId + client-oldali deviceKey
//
// Flow:
//   1. Kliens generál deviceKey-t (UUID), elmenti lokálisan
//   2. POST /devices/native/provision {hardwareId, deviceKeyHash, shortId, platform, version}
//      → pending:  {status:"pending", shortId}
//      → active:   {status:"active"}   (kliens a saját deviceKey-jével csatlakozik WS-re)
//   3. Admin aktiválja az Devices oldalon → Device létrejön deviceKeyHash-sel
//   4. Kliens poll-ol amíg active nem lesz

import { Router, Request, Response } from "express";
import { prisma }                    from "../../prisma/client";
import { randomBytes }               from "crypto";

const router = Router();

// In-memory store a pending native playerek deviceKeyHash-éhez
// (PendingDevice táblában nincs erre mező, ezért memóriában tároljuk)
// Key: shortId (pl. "WP-ABCD1234"), Value: deviceKeyHash
const pendingKeyHashes = new Map<string, string>();

// ── POST /devices/native/provision ────────────────────────────────────────────
// Nyilvános endpoint (nincs auth) – rate limit a caller oldalán ajánlott
router.post("/provision", async (req: Request, res: Response) => {
  try {
    const {
      hardwareId,    // MAC cím alapú azonosító (pl. "aa:bb:cc:dd:ee:ff")
      deviceKeyHash, // bcrypt(deviceKey) – kliens generálta
      shortId,       // "WP-ABCD1234" – a kliens azonosítója a UI-on
      platform,      // "windows" | "linux" | "android"
      version,       // app verzió
      userAgent,
    } = req.body ?? {};

    if (!hardwareId || !deviceKeyHash || !shortId) {
      return res.status(400).json({ error: "hardwareId, deviceKeyHash és shortId kötelező" });
    }

    const ipAddress = (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim()
      ?? req.socket.remoteAddress
      ?? null;

    // 1. Megvan-e már aktív Device ezzel a hardwareId-vel?
    const activeDevice = await prisma.device.findFirst({
      where: { serialNumber: hardwareId, authType: "KEY" },
      select: { id: true, tenantId: true },
    });

    if (activeDevice) {
      return res.json({ status: "active", deviceId: activeDevice.id });
    }

    // 2. Pending-ben van-e már?
    const existing = await prisma.pendingDevice.findFirst({
      where: { mac: hardwareId },
    });

    if (existing) {
      // Frissítjük a lastSeenAt-ot és az IP-t
      await prisma.pendingDevice.update({
        where: { id: existing.id },
        data: {
          lastSeenAt: new Date(),
          ipAddress:  ipAddress ?? existing.ipAddress,
          userAgent:  userAgent ?? existing.userAgent,
        },
      });
      // DeviceKeyHash memóriában frissítjük (kliens újraindulhatott)
      pendingKeyHashes.set(shortId, deviceKeyHash);
      return res.json({ status: "pending", shortId });
    }

    // 3. Új pending native player létrehozása
    await prisma.pendingDevice.create({
      data: {
        mac:         hardwareId,
        clientId:    shortId,       // shortId a UI azonosítójaként
        ipAddress,
        userAgent:   `${platform ?? "native"}/${version ?? "?"}${userAgent ? ` | ${userAgent}` : ""}`,
        firstSeenAt: new Date(),
        lastSeenAt:  new Date(),
      },
    });

    // DeviceKeyHash memóriában tárolva az aktiváláshoz
    pendingKeyHashes.set(shortId, deviceKeyHash);

    console.log(`[NativeProvision] Új pending native player: ${shortId} (${platform}) ip=${ipAddress}`);
    return res.json({ status: "pending", shortId });

  } catch (err) {
    console.error("[NativeProvision] hiba:", err);
    return res.status(500).json({ error: "Provisioning hiba" });
  }
});

// ── GET /devices/native/status/:hardwareId ────────────────────────────────────
// Kliens poll-ol: active lett-e már?
router.get("/status/:hardwareId", async (req: Request, res: Response) => {
  try {
    const hardwareId = String(req.params.hardwareId);

    const activeDevice = await prisma.device.findFirst({
      where: { serialNumber: hardwareId, authType: "KEY" },
      select: { id: true },
    });

    if (activeDevice) {
      return res.json({ status: "active", deviceId: activeDevice.id });
    }
    return res.json({ status: "pending" });
  } catch (err) {
    console.error("[NativeProvision] status hiba:", err);
    return res.status(500).json({ error: "Status lekérdezés hiba" });
  }
});

// ── GET /devices/native/info ──────────────────────────────────────────────────
// Visszaadja az eszköz tenant nevét device key alapján
router.get("/info", async (req: Request, res: Response) => {
  try {
    const deviceKey = req.headers["x-device-key"] as string;
    if (!deviceKey) return res.status(400).json({ error: "x-device-key required" });

    const { prisma } = await import("../../prisma/client");
    const bcrypt = await import("bcrypt");

    const devices = await prisma.device.findMany({
      where: { deviceKeyHash: { not: null }, authType: "KEY" },
      select: {
        id: true,
        deviceKeyHash: true,
        tenant: { select: { name: true } },
      },
    });

    let tenantName: string | null = null;
    for (const d of devices) {
      if (!d.deviceKeyHash) continue;
      const ok = await bcrypt.compare(deviceKey, d.deviceKeyHash);
      if (ok) {
        tenantName = d.tenant?.name ?? null;
        break;
      }
    }

    if (!tenantName) return res.status(401).json({ error: "Invalid device key" });
    return res.json({ ok: true, tenantName });
  } catch (err) {
    console.error("[NativeInfo] hiba:", err);
    return res.status(500).json({ error: "Info hiba" });
  }
});

// Eszköz jelzi hogy online – frissíti az online státuszt és lastSeenAt-t
router.post("/beacon", async (req: Request, res: Response) => {
  try {
    const deviceKey = req.headers["x-device-key"] as string;
    if (!deviceKey) return res.status(400).json({ error: "x-device-key header required" });

    // Megkeressük az eszközt a deviceKey hash alapján
    const { prisma } = await import("../../prisma/client");
    const bcrypt = await import("bcrypt");
    const devices = await prisma.device.findMany({
      where: { deviceKeyHash: { not: null }, authType: "KEY" },
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
        online:      true,
        lastSeenAt:  new Date(),
        ipAddress:   ipAddress ?? undefined,
      },
    });

    return res.json({ ok: true });
  } catch (err) {
    console.error("[NativeBeacon] hiba:", err);
    return res.status(500).json({ error: "Beacon hiba" });
  }
});

// ── GET /devices/native/snap-port ────────────────────────────────────────────
// ESP32 lekéri a saját tenant Snapcast portját device key alapján
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
// src/modules/devices/devices.admin.routes.ts

import { Router }        from "express";
import { prisma }        from "../../prisma/client";
import { authJwt }       from "../../middleware/authJwt";
import { requireTenant } from "../../middleware/tenant";
import bcrypt            from "bcrypt";
import { randomBytes }   from "crypto";
import { pendingKeyHashes } from "./devices.native.routes";

const router = Router();

type JwtUser = {
  sub?: string;
  role?: string;
  tenantId?: string | null;
};

const DEVICE_SELECT = {
  id: true,
  name: true,
  deviceClass: true,
  authType: true,
  firmwareVersion: true,
  ipAddress: true,
  online: true,
  lastSeenAt: true,
  volume: true,
  muted: true,
  createdAt: true,
  orgUnitId: true,
  serialNumber: true,
  clientId: true,
  userId: true,
  hwModel: true,
  otaStatus: true,
  otaProgress: true,
  otaVersion: true,
} as const;

// ─── GET /admin/devices/health ────────────────────────────────────────────
router.get("/health", authJwt, requireTenant, async (req, res) => {
  try {
    const user = (req as any).user as JwtUser;

    const devices = await prisma.device.findMany({
      where: { tenantId: user.tenantId! },
      select: DEVICE_SELECT,
      orderBy: [{ online: "desc" }, { name: "asc" }],
    });

    const now = Date.now();
    const result = devices.map((d) => ({
      deviceId:             d.id,
      name:                 d.name,
      deviceClass:          d.deviceClass,
      firmwareVersion:      d.firmwareVersion,
      ipAddress:            d.ipAddress,
      isOnline:             d.online,
      secondsSinceLastSeen: d.lastSeenAt
        ? Math.floor((now - new Date(d.lastSeenAt).getTime()) / 1000)
        : null,
      volume:      d.volume,
      muted:       d.muted,
      createdAt:   d.createdAt,
      orgUnitId:   d.orgUnitId,
      serialNumber: d.serialNumber,
      authType:    d.authType,
      hwModel:     d.hwModel,
      otaStatus:   d.otaStatus,
      otaProgress: d.otaProgress,
      otaVersion:  d.otaVersion,
      isVirtualPlayer: d.authType === "JWT" && !!d.userId,
      isNativePlayer:  d.authType === "KEY" && !d.serialNumber?.startsWith("ESP"),
    }));

    return res.json({
      ok: true,
      devices: result,
      totalRegistered: result.length,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Failed to fetch devices" });
  }
});

// ─── GET /admin/devices/pending-web ──────────────────────────────────────
router.get("/pending-web", authJwt, requireTenant, async (req, res) => {
  try {
    const user = (req as any).user as JwtUser;
    if (!["SUPER_ADMIN", "TENANT_ADMIN", "ORG_ADMIN"].includes(user.role ?? "")) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const pending = await prisma.pendingDevice.findMany({
      where: { clientId: { not: null }, mac: { startsWith: "WP-" } },
      orderBy: { lastSeenAt: "desc" },
    });

    const userIds = pending.map(p => p.userId).filter((id): id is string => !!id);
    const activatedUserIds = userIds.length > 0
      ? (await prisma.device.findMany({
          where: { userId: { in: userIds }, tenantId: user.tenantId! },
          select: { userId: true },
        })).map(d => d.userId).filter(Boolean)
      : [];

    const result = pending
      .filter(p => !activatedUserIds.includes(p.userId))
      .map(p => ({
        id: p.id, mac: p.mac, clientId: p.clientId, userId: p.userId,
        ipAddress: p.ipAddress, userAgent: p.userAgent,
        firstSeenAt: p.firstSeenAt, lastSeenAt: p.lastSeenAt,
      }));

    return res.json({ ok: true, pendingWeb: result });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Failed to fetch pending web players" });
  }
});

// ─── GET /admin/devices/pending-native ───────────────────────────────────
// Native playerek (Windows/Linux/Android) – MAC alapú azonosítás
router.get("/pending-native", authJwt, requireTenant, async (req, res) => {
  try {
    const user = (req as any).user as JwtUser;
    if (!["SUPER_ADMIN", "TENANT_ADMIN", "ORG_ADMIN"].includes(user.role ?? "")) {
      return res.status(403).json({ error: "Forbidden" });
    }

    // Native playerek: mac nem "WP-" kezdetű és nem tipikus ESP32 MAC (colons)
    // hanem a devices.native.routes által beillesztett hardwareId
    const pending = await (prisma as any).pendingDevice.findMany({
      where: {
        mac: {
          not: { startsWith: "WP-" },
        },
        clientId: { not: null },
        // clientId "NP-" kezdetű VAGY shortId-re illő (WP-XXXXXXXX)
        // A native player shortId-je "WP-" kezdetű, mac a hardwareId (MAC cím)
      },
      orderBy: { lastSeenAt: "desc" },
    });

    // Kiszűrjük azokat, amelyeket már aktiváltunk (Device.serialNumber = hardwareId)
    const activatedMacs = (await prisma.device.findMany({
      where: {
        tenantId:     user.tenantId!,
        serialNumber: { not: null },
        authType:     "KEY",
      },
      select: { serialNumber: true },
    })).map(d => d.serialNumber).filter(Boolean);

    const result = pending
      .filter((p: any) => !activatedMacs.includes(p.mac))
      .map((p: any) => ({
        id:          p.id,
        hardwareId:  p.mac,           // MAC cím
        shortId:     p.clientId,      // WP-XXXXXXXX
        ipAddress:   p.ipAddress,
        platform:    p.userAgent,     // "windows/1.0.0 | ..." formátumban
        firstSeenAt: p.firstSeenAt,
        lastSeenAt:  p.lastSeenAt,
        hasKeyHash:  pendingKeyHashes.has(p.clientId ?? ""),
      }));

    return res.json({ ok: true, pendingNative: result });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Failed to fetch pending native players" });
  }
});

// ─── POST /admin/devices/activate-native/:pendingId ──────────────────────
router.post("/activate-native/:pendingId", authJwt, requireTenant, async (req, res) => {
  try {
    const user = (req as any).user as JwtUser;
    if (!["SUPER_ADMIN", "TENANT_ADMIN", "ORG_ADMIN"].includes(user.role ?? "")) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const pendingId  = String(req.params.pendingId);
    const { name, deviceClass = "MULTI" } = req.body ?? {};

    if (!name?.trim()) {
      return res.status(400).json({ error: "Eszköznév kötelező" });
    }

    const pending = await prisma.pendingDevice.findUnique({ where: { id: pendingId } });
    if (!pending) {
      return res.status(404).json({ error: "Pending native player nem található" });
    }

    const hardwareId = pending.mac;   // MAC cím
    const shortId    = pending.clientId ?? "";

    // Van-e már aktív device ezzel a hardwareId-vel?
    const existingDevice = await prisma.device.findFirst({
      where: { serialNumber: hardwareId, tenantId: user.tenantId! },
    });
    if (existingDevice) {
      return res.status(409).json({ error: "Ez az eszköz már aktiválva van" });
    }

    // DeviceKeyHash lekérése a memóriából
    const deviceKeyHash = pendingKeyHashes.get(shortId);
    if (!deviceKeyHash) {
      return res.status(400).json({
        error: "DeviceKey hash nem elérhető. Az eszköznek online kell lennie az aktiváláshoz.",
      });
    }

    // Platform felismerése a userAgent-ből
    const platform = pending.userAgent?.split("/")?.[0] ?? "native";
    const hwModel  = platform === "windows" ? "VIRTUAL_WIN"
                   : platform === "linux"   ? "VIRTUAL_LINUX"
                   : platform === "android" ? "VIRTUAL_ANDROID"
                   : "VIRTUAL";

    // Device létrehozása
    const device = await prisma.device.create({
      data: {
        tenantId:        user.tenantId!,
        name:            name.trim(),
        authType:        "KEY",
        deviceClass:     deviceClass as any,
        serialNumber:    hardwareId,    // MAC cím mint egyedi azonosító
        clientId:        shortId,
        deviceKeyHash,                  // bcrypt hash – kliens saját maga generálta
        ipAddress:       pending.ipAddress,
        firmwareVersion: pending.userAgent?.match(/\/([^\s|]+)/)?.[1] ?? "native",
        hwModel,
        online:          false,
        volume:          7,
      },
    });

    // Pending törlése
    await prisma.pendingDevice.delete({ where: { id: pendingId } });
    pendingKeyHashes.delete(shortId);

    console.log(`[NativeActivate] Aktiválva: ${shortId} → ${device.id} (${hwModel})`);
    return res.status(201).json({ ok: true, device });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Failed to activate native player" });
  }
});

// ─── POST /admin/devices/activate-web/:pendingId ─────────────────────────
router.post("/activate-web/:pendingId", authJwt, requireTenant, async (req, res) => {
  try {
    const user = (req as any).user as JwtUser;
    if (!["SUPER_ADMIN", "TENANT_ADMIN", "ORG_ADMIN"].includes(user.role ?? "")) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const pendingId = String(req.params.pendingId);
    const { name } = req.body ?? {};

    const pending = await prisma.pendingDevice.findUnique({ where: { id: pendingId } });
    if (!pending || !pending.clientId || !pending.userId) {
      return res.status(404).json({ error: "Pending web player not found" });
    }

    const existing = await prisma.device.findFirst({
      where: { userId: pending.userId, tenantId: user.tenantId! },
    });
    if (existing) return res.status(409).json({ error: "This user already has an active device" });

    const playerUser = await prisma.user.findUnique({
      where: { id: pending.userId },
      select: { id: true, displayName: true, email: true, tenantId: true },
    });
    if (!playerUser || playerUser.tenantId !== user.tenantId) {
      return res.status(404).json({ error: "Player user not found or wrong tenant" });
    }

    const deviceName = name?.trim() || playerUser.displayName || playerUser.email || "Web Player";

    const device = await prisma.device.create({
      data: {
        tenantId: user.tenantId!, name: deviceName,
        authType: "JWT", deviceClass: "MULTI",
        clientId: pending.clientId, userId: pending.userId,
        ipAddress: pending.ipAddress,
        firmwareVersion: "WP", hwModel: "VIRTUAL",
        online: false, volume: 7,
      },
    });

    await prisma.pendingDevice.delete({ where: { id: pendingId } });
    return res.status(201).json({ ok: true, device });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Failed to activate web player" });
  }
});

// ─── POST /admin/devices/:id/reset-provision ─────────────────────────────
// Eszköz visszaállítása provisioning módba (törlés → kliens újra pending lesz)
router.post("/:id/reset-provision", authJwt, requireTenant, async (req, res) => {
  try {
    const user = (req as any).user as JwtUser;
    if (user.role !== "SUPER_ADMIN" && user.role !== "TENANT_ADMIN") {
      return res.status(403).json({ error: "Forbidden" });
    }

    const id = String(req.params.id).trim();
    const device = await prisma.device.findFirst({
      where: { id, tenantId: user.tenantId! },
      select: { id: true, name: true, clientId: true, authType: true },
    });
    if (!device) return res.status(404).json({ error: "Device not found" });
    if (device.authType !== "KEY") {
      return res.status(400).json({ error: "Csak native player (KEY auth) állítható vissza provisioning módba" });
    }

    // Töröljük a device-t – a kliens következő poll-nál "pending" státuszt kap
    await prisma.device.delete({ where: { id } });

    // DeviceKeyHash memóriából is töröljük ha van
    if (device.clientId) {
      pendingKeyHashes.delete(device.clientId);
    }

    console.log(`[ResetProvision] Visszaállítva: ${device.name} (${id})`);
    return res.json({ ok: true, message: `${device.name} visszaállítva provisioning módba` });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Failed to reset device" });
  }
});

// ─── PATCH /admin/devices/:id ─────────────────────────────────────────────
router.patch("/:id", authJwt, requireTenant, async (req, res) => {
  try {
    const user = (req as any).user as JwtUser;
    if (!["SUPER_ADMIN", "TENANT_ADMIN", "ORG_ADMIN"].includes(user.role ?? "")) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const id = String(req.params.id).trim();
    const { name, orgUnitId, volume, muted, hwModel } = req.body ?? {};

    const existing = await prisma.device.findFirst({
      where: { id, tenantId: user.tenantId! },
    });
    if (!existing) return res.status(404).json({ error: "Device not found" });

    const data: Record<string, unknown> = {};
    if (name?.trim())                    data.name      = name.trim();
    if (typeof orgUnitId !== "undefined") data.orgUnitId = orgUnitId ?? null;
    if (typeof volume !== "undefined")    data.volume    = Math.min(10, Math.max(0, Number(volume)));
    if (typeof muted !== "undefined")     data.muted     = Boolean(muted);
    if (hwModel?.trim())                  data.hwModel   = hwModel.trim();

    const updated = await prisma.device.update({ where: { id }, data, select: DEVICE_SELECT });
    return res.json({ ok: true, device: updated });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Failed to update device" });
  }
});

// ─── DELETE /admin/devices/:id ────────────────────────────────────────────
router.delete("/:id", authJwt, requireTenant, async (req, res) => {
  try {
    const user = (req as any).user as JwtUser;
    if (user.role !== "SUPER_ADMIN" && user.role !== "TENANT_ADMIN") {
      return res.status(403).json({ error: "Forbidden" });
    }
    const id = String(req.params.id).trim();
    if (!id) return res.status(400).json({ error: "id is required" });
    const existing = await prisma.device.findFirst({
      where: { id, tenantId: user.tenantId! }, select: { id: true, clientId: true },
    });
    if (!existing) return res.status(404).json({ error: "Device not found" });

    // Native player esetén memóriából is töröljük
    if (existing.clientId) {
      pendingKeyHashes.delete(existing.clientId);
    }

    await prisma.device.delete({ where: { id } });
    return res.json({ ok: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Failed to delete device" });
  }
});

// ═══ CSOPORTOK ═══════════════════════════════════════════════════════════════

router.get("/groups", authJwt, requireTenant, async (req, res) => {
  try {
    const user = (req as any).user as JwtUser;
    if (!user?.tenantId) return res.status(400).json({ error: "Tenant required" });
    const groups = await prisma.deviceGroup.findMany({
      where: { tenantId: user.tenantId },
      include: { members: { select: { deviceId: true } } },
      orderBy: { name: "asc" },
    });
    return res.json({ ok: true, groups: groups.map(g => ({
      id: g.id, name: g.name, createdAt: g.createdAt,
      deviceIds: g.members.map(m => m.deviceId),
    }))});
  } catch (err) { console.error(err); return res.status(500).json({ error: "Failed" }); }
});

router.post("/groups", authJwt, requireTenant, async (req, res) => {
  try {
    const user = (req as any).user as JwtUser;
    if (!user?.tenantId) return res.status(400).json({ error: "Tenant required" });
    const { name } = req.body ?? {};
    if (!name?.trim()) return res.status(400).json({ error: "name is required" });
    const group = await prisma.deviceGroup.create({
      data: { tenantId: user.tenantId, name: name.trim() },
      include: { members: { select: { deviceId: true } } },
    });
    return res.status(201).json({ ok: true, group: { id: group.id, name: group.name, deviceIds: [] } });
  } catch (err: any) {
    if (err?.code === "P2002") return res.status(409).json({ error: "Ilyen nevű csoport már létezik" });
    console.error(err); return res.status(500).json({ error: "Failed" });
  }
});

router.patch("/groups/:id", authJwt, requireTenant, async (req, res) => {
  try {
    const user = (req as any).user as JwtUser;
    if (!user?.tenantId) return res.status(400).json({ error: "Tenant required" });
    const { name, deviceIds } = req.body ?? {};
    const existing = await prisma.deviceGroup.findFirst({
      where: { id: String(req.params.id), tenantId: user.tenantId },
    });
    if (!existing) return res.status(404).json({ error: "Not found" });
    await prisma.$transaction(async (tx) => {
      if (name?.trim()) await tx.deviceGroup.update({ where: { id: existing.id }, data: { name: name.trim() } });
      if (Array.isArray(deviceIds)) {
        await tx.deviceGroupMember.deleteMany({ where: { groupId: existing.id } });
        if (deviceIds.length > 0) {
          await tx.deviceGroupMember.createMany({
            data: deviceIds.map((deviceId: string) => ({ groupId: existing.id, deviceId })),
            skipDuplicates: true,
          });
        }
      }
    });
    const updated = await prisma.deviceGroup.findFirst({
      where: { id: existing.id },
      include: { members: { select: { deviceId: true } } },
    });
    return res.json({ ok: true, group: {
      id: updated!.id, name: updated!.name,
      deviceIds: updated!.members.map(m => m.deviceId),
    }});
  } catch (err: any) {
    if (err?.code === "P2002") return res.status(409).json({ error: "Ilyen nevű csoport már létezik" });
    console.error(err); return res.status(500).json({ error: "Failed" });
  }
});

router.delete("/groups/:id", authJwt, requireTenant, async (req, res) => {
  try {
    const user = (req as any).user as JwtUser;
    if (!user?.tenantId) return res.status(400).json({ error: "Tenant required" });
    const existing = await prisma.deviceGroup.findFirst({
      where: { id: String(req.params.id), tenantId: user.tenantId },
    });
    if (!existing) return res.status(404).json({ error: "Not found" });
    await prisma.deviceGroup.delete({ where: { id: existing.id } });
    return res.json({ ok: true });
  } catch (err) { console.error(err); return res.status(500).json({ error: "Failed" }); }
});

export default router;
// src/modules/devices/devices.admin.routes.ts

import { Router } from "express";
import { prisma } from "../../prisma/client";
import { authJwt } from "../../middleware/authJwt";
import { requireTenant } from "../../middleware/tenant";

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
      isVirtualPlayer: d.authType === "JWT" && !!d.userId,
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
// Aktiválásra váró WebPlayer eszközök listája
router.get("/pending-web", authJwt, requireTenant, async (req, res) => {
  try {
    const user = (req as any).user as JwtUser;
    if (!["SUPER_ADMIN", "TENANT_ADMIN", "ORG_ADMIN"].includes(user.role ?? "")) {
      return res.status(403).json({ error: "Forbidden" });
    }

    // PendingDevice-ok ahol van clientId (WebPlayer) és nincs még Device
    const pending = await prisma.pendingDevice.findMany({
      where: {
        clientId: { not: null },
        mac:      { startsWith: "WP-" },
      },
      orderBy: { lastSeenAt: "desc" },
    });

    // Szűrjük ki azokat ahol már van aktív Device (userId alapján)
    const userIds = pending
      .map(p => p.userId)
      .filter((id): id is string => !!id);

    const activatedUserIds = userIds.length > 0
      ? (await prisma.device.findMany({
          where: { userId: { in: userIds }, tenantId: user.tenantId! },
          select: { userId: true },
        })).map(d => d.userId).filter(Boolean)
      : [];

    const result = pending
      .filter(p => !activatedUserIds.includes(p.userId))
      .map(p => ({
        id:          p.id,
        mac:         p.mac,
        clientId:    p.clientId,
        userId:      p.userId,
        ipAddress:   p.ipAddress,
        userAgent:   p.userAgent,
        firstSeenAt: p.firstSeenAt,
        lastSeenAt:  p.lastSeenAt,
      }));

    return res.json({ ok: true, pendingWeb: result });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Failed to fetch pending web players" });
  }
});

// ─── POST /admin/devices/activate-web/:pendingId ─────────────────────────
// WebPlayer aktiválása: PendingDevice → Device
router.post("/activate-web/:pendingId", authJwt, requireTenant, async (req, res) => {
  try {
    const user = (req as any).user as JwtUser;
    if (!["SUPER_ADMIN", "TENANT_ADMIN", "ORG_ADMIN"].includes(user.role ?? "")) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const pendingId = String(req.params.pendingId);
    const { name } = req.body ?? {};

    const pending = await prisma.pendingDevice.findUnique({
      where: { id: pendingId },
    });

    if (!pending || !pending.clientId || !pending.userId) {
      return res.status(404).json({ error: "Pending web player not found" });
    }

    // Ellenőrzés: nincs-e már aktív Device ehhez a userId-hoz
    const existing = await prisma.device.findFirst({
      where: { userId: pending.userId, tenantId: user.tenantId! },
    });
    if (existing) {
      return res.status(409).json({ error: "This user already has an active device" });
    }

    // PLAYER user adatai
    const playerUser = await prisma.user.findUnique({
      where: { id: pending.userId },
      select: { id: true, displayName: true, email: true, tenantId: true },
    });

    if (!playerUser || playerUser.tenantId !== user.tenantId) {
      return res.status(404).json({ error: "Player user not found or wrong tenant" });
    }

    const deviceName = name?.trim() || playerUser.displayName || playerUser.email || "Web Player";

    // Device létrehozása
    const device = await prisma.device.create({
      data: {
        tenantId:        user.tenantId!,
        name:            deviceName,
        authType:        "JWT",
        deviceClass:     "MULTI",
        clientId:        pending.clientId,
        userId:          pending.userId,
        ipAddress:       pending.ipAddress,
        firmwareVersion: "WP",
        online:          false,
        volume:          7,
      },
    });

    // PendingDevice törlése
    await prisma.pendingDevice.delete({ where: { id: pendingId } });

    return res.status(201).json({ ok: true, device });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Failed to activate web player" });
  }
});

// ─── PATCH /admin/devices/:id ─────────────────────────────────────────────
// Eszköz szerkesztése (név, orgUnit)
router.patch("/:id", authJwt, requireTenant, async (req, res) => {
  try {
    const user = (req as any).user as JwtUser;
    if (!["SUPER_ADMIN", "TENANT_ADMIN", "ORG_ADMIN"].includes(user.role ?? "")) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const id = String(req.params.id).trim();
    const { name, orgUnitId, volume, muted } = req.body ?? {};

    const existing = await prisma.device.findFirst({
      where: { id, tenantId: user.tenantId! },
    });
    if (!existing) return res.status(404).json({ error: "Device not found" });

    const data: Record<string, unknown> = {};
    if (name?.trim())              data.name      = name.trim();
    if (typeof orgUnitId !== "undefined") data.orgUnitId = orgUnitId ?? null;
    if (typeof volume    !== "undefined") data.volume    = Math.min(10, Math.max(0, Number(volume)));
    if (typeof muted     !== "undefined") data.muted     = Boolean(muted);

    const updated = await prisma.device.update({
      where: { id },
      data,
      select: DEVICE_SELECT,
    });

    return res.json({ ok: true, device: updated });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Failed to update device" });
  }
});

// ─── DELETE /admin/devices/:id ────────────────────────────────────────────
// PLAYER (JWT) eszköz NEM törölhető – csak az ESP32-k
router.delete("/:id", authJwt, requireTenant, async (req, res) => {
  try {
    const user = (req as any).user as JwtUser;
    if (user.role !== "SUPER_ADMIN" && user.role !== "TENANT_ADMIN") {
      return res.status(403).json({ error: "Forbidden" });
    }

    const id = String(req.params.id).trim();
    if (!id) return res.status(400).json({ error: "id is required" });

    const existing = await prisma.device.findFirst({
      where: { id, tenantId: user.tenantId! },
      select: { id: true },
    });

    if (!existing) return res.status(404).json({ error: "Device not found" });

    await prisma.device.delete({ where: { id } });

    return res.json({ ok: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Failed to delete device" });
  }
});

export default router;
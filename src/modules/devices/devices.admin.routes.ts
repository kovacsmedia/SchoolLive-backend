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

/**
 * GET /admin/devices/health
 * Eszközök listája tenant-scope-pal + online státusz
 */
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
      deviceId: d.id,
      name: d.name,
      deviceClass: d.deviceClass,
      firmwareVersion: d.firmwareVersion,
      ipAddress: d.ipAddress,
      isOnline: d.online,
      secondsSinceLastSeen: d.lastSeenAt
        ? Math.floor((now - new Date(d.lastSeenAt).getTime()) / 1000)
        : null,
      volume: d.volume,
      muted: d.muted,
      createdAt: d.createdAt,
      orgUnitId: d.orgUnitId,
      serialNumber: d.serialNumber,
      authType: d.authType,
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

/**
 * DELETE /admin/devices/:id
 * Eszköz törlése (csak SUPER_ADMIN és TENANT_ADMIN)
 */
router.delete("/:id", authJwt, requireTenant, async (req, res) => {
  try {
    const user = (req as any).user as JwtUser;

    if (user.role !== "SUPER_ADMIN" && user.role !== "TENANT_ADMIN") {
      return res.status(403).json({ error: "Forbidden" });
    }

    const id = req.params.id?.trim();
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
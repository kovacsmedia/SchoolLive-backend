import { Router } from "express";
import { prisma } from "../../prisma/client";
import { authJwt } from "../../middleware/authJwt";
import type { CommandStatus, Prisma } from "@prisma/client";

const router = Router();

function isAdminRole(role: string | undefined): boolean {
  return role === "SUPER_ADMIN" || role === "TENANT_ADMIN";
}

/**
 * GET /admin/commands
 * List last 100 commands for tenant (or all for SUPER_ADMIN)
 */
router.get("/", authJwt, async (req, res) => {
  try {
    const user = (req as any).user as { role?: string; tenantId?: string | null } | undefined;
    if (!user?.role) return res.status(401).json({ ok: false, error: "UNAUTHORIZED" });

    const whereClause: Prisma.DeviceCommandWhereInput =
      user.role === "SUPER_ADMIN" ? {} : { tenantId: user.tenantId ?? undefined };

    const commands = await prisma.deviceCommand.findMany({
      where: whereClause,
      orderBy: { queuedAt: "desc" },
      take: 100,
    });

    const sanitized = commands.map((c) => ({
      id: c.id,
      tenantId: c.tenantId,
      deviceId: c.deviceId,
      type: (c.payload as any)?.type ?? null,
      status: c.status,
      queuedAt: c.queuedAt,
      sentAt: c.sentAt,
      ackedAt: c.ackedAt,
      retryCount: c.retryCount,
      maxRetries: c.maxRetries,
      error: c.error,
      lastError: c.lastError,
    }));

    res.json({ ok: true, count: sanitized.length, commands: sanitized });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: "Failed to fetch commands" });
  }
});

/**
 * GET /admin/commands/:id
 * Single command status (poll-friendly)
 */
router.get("/:id", authJwt, async (req, res) => {
  try {
    const user = (req as any).user as { role?: string; tenantId?: string | null } | undefined;
    if (!user?.role) return res.status(401).json({ ok: false, error: "UNAUTHORIZED" });

    const id = req.params.id;
    const where: Prisma.DeviceCommandWhereUniqueInput = { id };

    const command = await prisma.deviceCommand.findUnique({ where });
    if (!command) return res.status(404).json({ ok: false, error: "NOT_FOUND" });

    // tenant isolation
    if (user.role !== "SUPER_ADMIN" && command.tenantId !== user.tenantId) {
      return res.status(404).json({ ok: false, error: "NOT_FOUND" });
    }

    return res.json({
      ok: true,
      command: {
        id: command.id,
        tenantId: command.tenantId,
        deviceId: command.deviceId,
        type: (command.payload as any)?.type ?? null,
        payload: command.payload,
        status: command.status,
        queuedAt: command.queuedAt,
        sentAt: command.sentAt,
        ackedAt: command.ackedAt,
        retryCount: command.retryCount,
        maxRetries: command.maxRetries,
        error: command.error,
        lastError: command.lastError,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: "Failed to fetch command" });
  }
});

/**
 * POST /admin/commands
 * Body:
 * {
 *   "deviceId": "uuid",
 *   "type": "SET_VOLUME",
 *   "payload": { "volume": 7 }
 * }
 *
 * Deterministic: only 1 active (QUEUED or SENT) per device.
 */
router.post("/", authJwt, async (req, res) => {
  try {
    const user = (req as any).user as { role?: string; tenantId?: string | null } | undefined;
    if (!user?.role) return res.status(401).json({ ok: false, error: "UNAUTHORIZED" });

    if (!isAdminRole(user.role)) {
      return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    }

    const { deviceId, type, payload } = req.body ?? {};

    if (!deviceId || typeof deviceId !== "string") {
      return res.status(400).json({ ok: false, error: "VALIDATION_ERROR", details: "deviceId is required" });
    }
    if (!type || typeof type !== "string") {
      return res.status(400).json({ ok: false, error: "VALIDATION_ERROR", details: "type is required" });
    }
    if (payload === undefined || payload === null || typeof payload !== "object") {
      return res.status(400).json({ ok: false, error: "VALIDATION_ERROR", details: "payload must be an object" });
    }

    // Minimal validation for SET_VOLUME (0..10)
    if (type === "SET_VOLUME") {
      const volume = (payload as any).volume;
      if (typeof volume !== "number" || !Number.isFinite(volume) || volume < 0 || volume > 10) {
        return res.status(400).json({
          ok: false,
          error: "VALIDATION_ERROR",
          details: "payload.volume must be a number between 0 and 10",
        });
      }
    }

    const result = await prisma.$transaction(async (tx) => {
      // Tenant scope: SUPER_ADMIN can target any device; TENANT_ADMIN only own tenant
      const device = await tx.device.findFirst({
        where:
          user.role === "SUPER_ADMIN"
            ? { id: deviceId }
            : { id: deviceId, tenantId: user.tenantId ?? undefined },
        select: { id: true, tenantId: true },
      });

      if (!device) return { kind: "DEVICE_NOT_FOUND" as const };

      const active = await tx.deviceCommand.findFirst({
        where: {
          tenantId: device.tenantId,
          deviceId: deviceId,
          status: { in: ["QUEUED", "SENT"] as CommandStatus[] },
        },
        orderBy: { queuedAt: "desc" },
        select: { id: true, status: true, queuedAt: true },
      });

      if (active) return { kind: "CONFLICT" as const, active };

      const command = await tx.deviceCommand.create({
        data: {
          tenantId: device.tenantId,
          deviceId: deviceId,
          messageId: null,
          payload: { type, ...(payload as object) },
          status: "QUEUED",
        },
      });

      return { kind: "OK" as const, command };
    });

    if (result.kind === "DEVICE_NOT_FOUND") {
      return res.status(404).json({ ok: false, error: "DEVICE_NOT_FOUND" });
    }
    if (result.kind === "CONFLICT") {
      return res.status(409).json({
        ok: false,
        error: "DEVICE_HAS_ACTIVE_COMMAND",
        active: result.active,
      });
    }

    return res.status(201).json({ ok: true, command: result.command });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: "Failed to create command" });
  }
});

/**
 * GET /admin/commands/summary
 */
router.get("/summary", authJwt, async (req, res) => {
  try {
    const user = (req as any).user as { role?: string; tenantId?: string | null } | undefined;
    if (!user?.role) return res.status(401).json({ ok: false, error: "UNAUTHORIZED" });

    const whereClause: Prisma.DeviceCommandWhereInput =
      user.role === "SUPER_ADMIN" ? {} : { tenantId: user.tenantId ?? undefined };

    const grouped = await prisma.deviceCommand.groupBy({
      by: ["status"],
      where: whereClause,
      _count: { status: true },
    });

    const summary: Record<string, number> = {};
    grouped.forEach((g) => {
      summary[g.status] = g._count.status;
    });

    res.json({ ok: true, summary });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: "Failed to fetch summary" });
  }
});

/**
 * GET /admin/commands/stuck?minutes=5
 */
router.get("/stuck", authJwt, async (req, res) => {
  try {
    const user = (req as any).user as { role?: string; tenantId?: string | null } | undefined;
    if (!user?.role) return res.status(401).json({ ok: false, error: "UNAUTHORIZED" });

    const whereTenant: Prisma.DeviceCommandWhereInput =
      user.role === "SUPER_ADMIN" ? {} : { tenantId: user.tenantId ?? undefined };

    const minutes = Number(req.query.minutes ?? 5);
    const threshold = new Date(Date.now() - minutes * 60 * 1000);

    const stuck = await prisma.deviceCommand.findMany({
      where: {
        ...whereTenant,
        status: "SENT",
        ackedAt: null,
        sentAt: { lt: threshold },
      },
      orderBy: { sentAt: "asc" },
    });

    res.json({
      ok: true,
      minutes,
      count: stuck.length,
      commands: stuck.map((c) => ({
        id: c.id,
        deviceId: c.deviceId,
        sentAt: c.sentAt,
        retryCount: c.retryCount,
        maxRetries: c.maxRetries,
        error: c.error,
        lastError: c.lastError,
      })),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: "Failed to fetch stuck commands" });
  }
});

export default router;
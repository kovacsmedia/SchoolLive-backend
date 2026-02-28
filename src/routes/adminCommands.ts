import { Router } from "express";
import prisma from "../prisma";
import { authJwt } from "../middleware/authJwt";

const router = Router();

/**
 * POST /admin/commands
 * Body:
 * {
 *   "deviceId": "uuid",
 *   "type": "SET_VOLUME",
 *   "payload": { "volume": 7 }
 * }
 *
 * Returns:
 * 201 { ok: true, command: DeviceCommand }
 */
router.post("/commands", authJwt, async (req, res) => {
  try {
    // authJwt-nek már be kellett raknia a user-t
    const user = (req as any).user as { id: string; tenantId: string; role?: string; roles?: string[] } | undefined;
    if (!user?.tenantId) {
      return res.status(401).json({ ok: false, error: "UNAUTHORIZED" });
    }

    const roles = Array.isArray(user.roles) ? user.roles : (user.role ? [user.role] : []);
    const isAdmin = roles.includes("ADMIN") || roles.includes("SUPER_ADMIN");
    if (!isAdmin) {
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

    // Minimál validálás a konkrét use-case-re (SET_VOLUME)
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

    // Tenant-scoped device check + deterministic single active command
    const result = await prisma.$transaction(async (tx) => {
      const device = await tx.device.findFirst({
        where: {
          id: deviceId,
          tenantId: user.tenantId,
        },
        select: { id: true, tenantId: true },
      });

      if (!device) {
        return { kind: "NOT_FOUND" as const };
      }

      const existingActive = await tx.deviceCommand.findFirst({
        where: {
          tenantId: user.tenantId,
          deviceId: deviceId,
          status: { in: ["QUEUED", "SENT"] },
        },
        orderBy: { createdAt: "desc" },
        select: { id: true, status: true, createdAt: true },
      });

      if (existingActive) {
        return { kind: "CONFLICT" as const, existingActive };
      }

      const command = await tx.deviceCommand.create({
        data: {
          tenantId: user.tenantId,
          deviceId: deviceId,
          messageId: null,
          payload: { type, ...(payload as object) }, // firmware felé egységes payload
          status: "QUEUED",
        },
      });

      return { kind: "OK" as const, command };
    });

    if (result.kind === "NOT_FOUND") {
      return res.status(404).json({ ok: false, error: "DEVICE_NOT_FOUND" });
    }

    if (result.kind === "CONFLICT") {
      return res.status(409).json({
        ok: false,
        error: "DEVICE_HAS_ACTIVE_COMMAND",
        details: {
          id: result.existingActive.id,
          status: result.existingActive.status,
          createdAt: result.existingActive.createdAt,
        },
      });
    }

    return res.status(201).json({ ok: true, command: result.command });
  } catch (err) {
    console.error("POST /admin/commands error:", err);
    return res.status(500).json({ ok: false, error: "INTERNAL_ERROR" });
  }
});

export default router;
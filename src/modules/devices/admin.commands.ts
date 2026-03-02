import { Router } from "express";
import { prisma } from "../../prisma/client";
import { authJwt } from "../../middleware/authJwt";

type CommandStatus = "QUEUED" | "SENT" | "ACKED" | "FAILED";

type CreateAdminCommandBody = {
  deviceId: string;
  payload: Record<string, unknown>;
};

const router = Router();

/**
 * GET /admin/commands
 * Optional query:
 *  - deviceId=...
 *  - status=QUEUED|SENT|ACKED|FAILED
 *  - limit=...
 */
router.get("/", authJwt, async (req, res) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ ok: false, error: "UNAUTHORIZED" });
    }

    const deviceId = typeof req.query.deviceId === "string" ? req.query.deviceId : undefined;
    const status = typeof req.query.status === "string" ? (req.query.status as CommandStatus) : undefined;
    const limitRaw = typeof req.query.limit === "string" ? Number(req.query.limit) : 50;
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 200) : 50;

    // Prisma where: maradjunk egyszerű, TS-barát objektumnál
    const where: Record<string, unknown> = {};

    // Multi-tenant szűrés:
    // - SUPER_ADMIN mindent lát
    // - más role csak a saját tenantját
    if (user.role !== "SUPER_ADMIN") {
      where.tenantId = user.tenantId;
    }

    if (deviceId) where.deviceId = deviceId;
    if (status) where.status = status;

    const commands = await prisma.deviceCommand.findMany({
      where: where as any,
      // Ne használjunk createdAt-ot, mert a sémában lehet más a neve.
      // Stabil fallback: id desc (uuid esetén nem idő-alapú, de listázásra oké).
      orderBy: { id: "desc" } as any,
      take: limit,
    });

    res.json(commands);
  } catch (err) {
    console.error("GET /admin/commands error:", err);
    res.status(500).json({ ok: false, error: "INTERNAL_ERROR" });
  }
});

/**
 * POST /admin/commands
 * Body:
 *  {
 *    deviceId: string,
 *    payload: { type: "...", ... }
 *  }
 *
 * Determinisztikus kezelés:
 * - egy device-hoz egyszerre max 1 aktív (QUEUED vagy SENT) parancs
 * - ha van aktív, 409-et adunk vissza a meglévő parancs adataival
 */
router.post("/", authJwt, async (req, res) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ ok: false, error: "UNAUTHORIZED" });
    }

    // Minimum role check: SUPER_ADMIN vagy TENANT_ADMIN
    if (user.role !== "SUPER_ADMIN" && user.role !== "TENANT_ADMIN") {
      return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    }

    const body = req.body as Partial<CreateAdminCommandBody>;
    const deviceId = typeof body.deviceId === "string" ? body.deviceId.trim() : "";
    const payload = body.payload && typeof body.payload === "object" ? (body.payload as Record<string, unknown>) : null;

    if (!deviceId || !payload) {
      return res.status(400).json({ ok: false, error: "INVALID_BODY" });
    }

    // Device betöltés + tenant ellenőrzés
    const device = await prisma.device.findUnique({ where: { id: deviceId } });
    if (!device) {
      return res.status(404).json({ ok: false, error: "DEVICE_NOT_FOUND" });
    }

    // Tenant validáció: SUPER_ADMIN bármit, más csak saját tenantot
    if (user.role !== "SUPER_ADMIN" && device.tenantId !== user.tenantId) {
      return res.status(403).json({ ok: false, error: "CROSS_TENANT_FORBIDDEN" });
    }

    // Determinisztikus create tranzakcióban
    const created = await prisma.$transaction(async (tx) => {
      const existing = await tx.deviceCommand.findFirst({
        where: {
          deviceId: device.id,
          status: { in: ["QUEUED", "SENT"] },
        } as any,
        // createdAt helyett id desc
        orderBy: { id: "desc" } as any,
      });

      if (existing) {
        return { kind: "EXISTS" as const, existing };
      }

      const command = await tx.deviceCommand.create({
        data: {
          tenantId: device.tenantId,
          deviceId: device.id,
          payload: payload as any,
          status: "QUEUED",
        } as any,
      });

      return { kind: "CREATED" as const, command };
    });

    if (created.kind === "EXISTS") {
      return res.status(409).json({
        ok: false,
        error: "ACTIVE_COMMAND_EXISTS",
        command: created.existing,
      });
    }

    return res.status(201).json({ ok: true, command: created.command });
  } catch (err) {
    console.error("POST /admin/commands error:", err);
    res.status(500).json({ ok: false, error: "INTERNAL_ERROR" });
  }
});

export default router;
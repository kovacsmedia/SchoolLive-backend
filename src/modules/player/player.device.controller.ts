import { Request, Response } from "express";
import { prisma } from "../../prisma/client";

// PLAYER-nek csak a saját device-át engedjük kezelni (clientId alapján)
function ensurePlayer(req: Request, res: Response): { userId: string; tenantId: string } | null {
  const u = req.user;
  if (!u) {
    res.status(401).json({ error: "Unauthenticated" });
    return null;
  }
  if (u.role !== "PLAYER") {
    res.status(403).json({ error: "Forbidden" });
    return null;
  }
  if (!u.tenantId) {
    res.status(403).json({ error: "Tenant context required" });
    return null;
  }
  return { userId: u.sub, tenantId: u.tenantId };
}

function getIp(req: Request): string | null {
  return (
    (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ||
    req.socket.remoteAddress ||
    null
  );
}

/**
 * POST /player/device/register
 * body: { clientId: string, name?: string }
 *
 * Upsert Device:
 * - authType = JWT
 * - deviceKeyHash = null
 * - clientId + userId beállítva
 */
export async function registerPlayerDevice(req: Request, res: Response) {
  const ctx = ensurePlayer(req, res);
  if (!ctx) return;

  const { clientId, name } = req.body ?? {};
  if (!clientId || typeof clientId !== "string") {
    return res.status(400).json({ error: "clientId is required" });
  }

  const safeName =
    typeof name === "string" && name.trim().length > 0
      ? name.trim()
      : `PLAYER-${clientId.slice(0, 8)}`;

  const ipAddress = getIp(req);

  // upsert tenant+clientId alapon
  const existing = await prisma.device.findFirst({
    where: { tenantId: ctx.tenantId, clientId },
    select: { id: true, name: true },
  });

  const device = existing
    ? await prisma.device.update({
        where: { id: existing.id },
        data: {
          name: safeName,
          authType: "JWT",
          deviceKeyHash: null,
          clientId,
          userId: ctx.userId,
          ipAddress,
          firmwareVersion: "web-player",
          online: true,
          lastSeenAt: new Date(),
        },
        select: { id: true, tenantId: true, name: true, authType: true, clientId: true, userId: true, lastSeenAt: true },
      })
    : await prisma.device.create({
        data: {
          tenantId: ctx.tenantId,
          name: safeName,
          authType: "JWT",
          deviceKeyHash: null,
          clientId,
          userId: ctx.userId,
          ipAddress,
          firmwareVersion: "web-player",
          online: true,
          lastSeenAt: new Date(),
          volume: 5,
          muted: false,
        },
        select: { id: true, tenantId: true, name: true, authType: true, clientId: true, userId: true, lastSeenAt: true },
      });

  return res.json({ ok: true, device });
}

/**
 * POST /player/device/beacon
 * body: { clientId: string, volume?: number, muted?: boolean, statusPayload?: any }
 */
export async function beaconPlayerDevice(req: Request, res: Response) {
  const ctx = ensurePlayer(req, res);
  if (!ctx) return;

  const { clientId, volume, muted, statusPayload } = req.body ?? {};
  if (!clientId || typeof clientId !== "string") {
    return res.status(400).json({ error: "clientId is required" });
  }

  const device = await prisma.device.findFirst({
    where: { tenantId: ctx.tenantId, clientId, userId: ctx.userId, authType: "JWT" },
    select: { id: true },
  });

  if (!device) return res.status(404).json({ error: "Device not registered" });

  const updated = await prisma.device.update({
    where: { id: device.id },
    data: {
      online: true,
      lastSeenAt: new Date(),
      ipAddress: getIp(req),
      volume: typeof volume === "number" ? volume : undefined,
      muted: typeof muted === "boolean" ? muted : undefined,
      statusPayload: statusPayload ?? undefined,
    },
    select: { id: true, online: true, lastSeenAt: true },
  });

  return res.json({ ok: true, device: updated });
}

/**
 * POST /player/device/poll
 * body: { clientId: string }
 *
 * Ugyanaz a determinisztikus logika: ha van SENT, vár; ha timeout, retry; ha van QUEUED, kiküld.
 */
export async function pollPlayerCommands(req: Request, res: Response) {
  const ctx = ensurePlayer(req, res);
  if (!ctx) return;

  const { clientId } = req.body ?? {};
  if (!clientId || typeof clientId !== "string") {
    return res.status(400).json({ error: "clientId is required" });
  }

  const device = await prisma.device.findFirst({
    where: { tenantId: ctx.tenantId, clientId, userId: ctx.userId, authType: "JWT" },
    select: { id: true, tenantId: true },
  });

  if (!device) return res.status(404).json({ error: "Device not registered" });

  // keepalive
  await prisma.device.update({
    where: { id: device.id },
    data: { online: true, lastSeenAt: new Date(), ipAddress: getIp(req) },
  });

  // egyszerűsített: a devices.controller.ts-ben már kiforrott a retry/backoff,
  // itt egy MVP: ha van SENT, nem adunk újat; ha nincs, a legrégebbi QUEUED->SENT.
  const inFlight = await prisma.deviceCommand.findFirst({
    where: { tenantId: device.tenantId, deviceId: device.id, status: "SENT" },
    orderBy: { sentAt: "asc" },
  });

  if (inFlight) return res.json({ ok: true, command: null });

  const queued = await prisma.deviceCommand.findFirst({
    where: { tenantId: device.tenantId, deviceId: device.id, status: "QUEUED" },
    orderBy: { queuedAt: "asc" },
  });

  if (!queued) return res.json({ ok: true, command: null });

  const now = new Date();
  const updated = await prisma.deviceCommand.updateMany({
    where: { id: queued.id, status: "QUEUED" },
    data: { status: "SENT", sentAt: now },
  });

  if (updated.count === 0) return res.json({ ok: true, command: null });

  const fresh = await prisma.deviceCommand.findUnique({ where: { id: queued.id } });
  return res.json({ ok: true, command: fresh });
}

/**
 * POST /player/device/ack
 * body: { clientId: string, commandId: string, ok: boolean, error?: string }
 */
export async function ackPlayerCommand(req: Request, res: Response) {
  const ctx = ensurePlayer(req, res);
  if (!ctx) return;

  const { clientId, commandId, ok, error } = req.body ?? {};
  if (!clientId || typeof clientId !== "string") return res.status(400).json({ error: "clientId is required" });
  if (!commandId || typeof commandId !== "string") return res.status(400).json({ error: "commandId is required" });
  if (typeof ok !== "boolean") return res.status(400).json({ error: "ok is required (boolean)" });

  const device = await prisma.device.findFirst({
    where: { tenantId: ctx.tenantId, clientId, userId: ctx.userId, authType: "JWT" },
    select: { id: true, tenantId: true },
  });
  if (!device) return res.status(404).json({ error: "Device not registered" });

  const cmd = await prisma.deviceCommand.findFirst({
    where: { id: commandId, tenantId: device.tenantId, deviceId: device.id },
  });
  if (!cmd) return res.status(404).json({ error: "Command not found" });

  if (cmd.status === "ACKED" || cmd.status === "FAILED") {
    return res.json({ ok: true, command: cmd, note: "Already finalized" });
  }

  const updated = await prisma.deviceCommand.update({
    where: { id: cmd.id },
    data: {
      status: ok ? "ACKED" : "FAILED",
      ackedAt: new Date(),
      lastError: ok ? null : (typeof error === "string" ? error : "Player reported error"),
      error: ok ? null : (typeof error === "string" ? error : "Player reported error"),
    },
  });

  return res.json({ ok: true, command: updated });
}
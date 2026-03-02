import { Request, Response } from "express";
import { prisma } from "../../prisma/client";
import { playerPollCommands, playerAckCommand } from "../devices/devices.controller";

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
  return (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || req.socket.remoteAddress || null;
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
    typeof name === "string" && name.trim().length > 0 ? name.trim() : `PLAYER-${clientId.slice(0, 8)}`;

  const ipAddress = getIp(req);

  // upsert tenant+clientId alapon
  const existing = await prisma.device.findFirst({
    where: { tenantId: ctx.tenantId, clientId },
    select: { id: true },
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
        select: {
          id: true,
          tenantId: true,
          name: true,
          authType: true,
          clientId: true,
          userId: true,
          lastSeenAt: true,
        },
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
        select: {
          id: true,
          tenantId: true,
          name: true,
          authType: true,
          clientId: true,
          userId: true,
          lastSeenAt: true,
        },
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
 * Delegálás a közös, kiforrott determinisztikus logikára:
 * - retry/backoff
 * - max retries -> FAILED
 * - SENT in-flight kezelése
 */
export async function pollPlayerCommands(req: Request, res: Response) {
  return playerPollCommands(req, res);
}

/**
 * POST /player/device/ack
 * body: { clientId: string, commandId: string, ok: boolean, error?: string }
 *
 * Delegálás a közös ACK logikára
 */
export async function ackPlayerCommand(req: Request, res: Response) {
  return playerAckCommand(req, res);
}
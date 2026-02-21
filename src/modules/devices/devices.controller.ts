import { Request, Response } from "express";
import { prisma } from "../../prisma/client";

export async function listDevices(req: Request, res: Response) {
  const user = req.user!;
  // SUPER_ADMIN: tenantId null → ideiglenesen nem listázunk mindent, csak visszajelzünk
  if (user.role === "SUPER_ADMIN") {
    return res.json({ note: "SUPER_ADMIN has no tenant context. Use a tenant user to list devices." });
  }

  const devices = await prisma.device.findMany({
    where: { tenantId: user.tenantId! },
    select: {
      id: true,
      tenantId: true,
      orgUnitId: true,
      name: true,
      firmwareVersion: true,
      ipAddress: true,
      online: true,
      lastSeenAt: true,
      volume: true,
      muted: true,
      createdAt: true
    },
    orderBy: { createdAt: "desc" }
  });

  res.json(devices);
}
import crypto from "crypto";
import bcrypt from "bcrypt";

export async function registerDevice(req: Request, res: Response) {
  const user = req.user!;
  if (user.role !== "TENANT_ADMIN" && user.role !== "ORG_ADMIN") {
    return res.status(403).json({ error: "Forbidden" });
  }

  const { name, orgUnitId } = req.body ?? {};
  if (!name || typeof name !== "string") {
    return res.status(400).json({ error: "name is required" });
  }

  // egyszer használatos device key (plaintext)
  const deviceKey = crypto.randomBytes(24).toString("hex");
  const deviceKeyHash = await bcrypt.hash(deviceKey, 10);

  const device = await prisma.device.create({
    data: {
      tenantId: user.tenantId!,
      orgUnitId: orgUnitId ?? null,
      name,
      deviceKeyHash,
      online: false,
      volume: 5,
      muted: false
    },
    select: {
      id: true,
      name: true,
      tenantId: true,
      orgUnitId: true,
      createdAt: true
    }
  });

  // plaintext kulcsot csak most adjuk vissza!
  res.status(201).json({ device, deviceKey });
  
}
export async function deviceBeacon(req: Request, res: Response) {
  const dev = (req as any).device as { id: string; tenantId: string };

  const { volume, muted, statusPayload, firmwareVersion } = req.body ?? {};

  const ipAddress = (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim()
    || req.socket.remoteAddress
    || null;

  const updated = await prisma.device.update({
    where: { id: dev.id },
    data: {
      online: true,
      lastSeenAt: new Date(),
      ipAddress,
      firmwareVersion: typeof firmwareVersion === "string" ? firmwareVersion : undefined,
      volume: typeof volume === "number" ? volume : undefined,
      muted: typeof muted === "boolean" ? muted : undefined,
      statusPayload: statusPayload ?? undefined
    },
    select: { id: true, online: true, lastSeenAt: true }
  });

  res.json({ ok: true, device: updated });
}
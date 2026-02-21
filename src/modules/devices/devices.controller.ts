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

export async function createDeviceCommand(req: Request, res: Response) {
  const user = req.user!;
  if (user.role !== "TENANT_ADMIN" && user.role !== "ORG_ADMIN") {
    return res.status(403).json({ error: "Forbidden" });
  }

  const deviceId = req.params.id;
  const { payload } = req.body ?? {};

  if (!payload || typeof payload !== "object") {
    return res.status(400).json({ error: "payload is required (JSON object)" });
  }

  // tenant izoláció
  const device = await prisma.device.findFirst({
    where: {
      id: deviceId,
      tenantId: user.tenantId!
    }
  });

  if (!device) {
    return res.status(404).json({ error: "Device not found" });
  }

  const command = await prisma.deviceCommand.create({
    data: {
      tenantId: user.tenantId!,
      deviceId,
      payload,
      status: "QUEUED"
    }
  });

  res.status(201).json(command);
}
export async function pollCommands(req: Request, res: Response) {
  const dev = (req as any).device as { id: string; tenantId: string };

  // legelső QUEUED parancs
  const cmd = await prisma.deviceCommand.findFirst({
    where: {
      tenantId: dev.tenantId,
      deviceId: dev.id,
      status: "QUEUED"
    },
    orderBy: { queuedAt: "asc" }
  });

  if (!cmd) {
    return res.json({ ok: true, command: null });
  }

  // jelöljük elküldöttnek
 const updated = await prisma.deviceCommand.updateMany({
  where: { id: cmd.id, status: "QUEUED" },
  data: { status: "SENT", sentAt: new Date() }
});

if (updated.count === 0) {
  return res.json({ ok: true, command: null });
}

const fresh = await prisma.deviceCommand.findUnique({ where: { id: cmd.id } });
return res.json({ ok: true, command: fresh });

  res.json({ ok: true, command: updated });
}
export async function ackCommand(req: Request, res: Response) {
  const dev = (req as any).device as { id: string; tenantId: string };

  const { commandId, ok, error } = req.body ?? {};
  if (!commandId || typeof commandId !== "string") {
    return res.status(400).json({ error: "commandId is required" });
  }
  if (typeof ok !== "boolean") {
    return res.status(400).json({ error: "ok is required (boolean)" });
  }

  // csak a saját tenant + saját device parancsát ACK-elheti
  const cmd = await prisma.deviceCommand.findFirst({
    where: {
      id: commandId,
      tenantId: dev.tenantId,
      deviceId: dev.id
    }
  });

  if (!cmd) {
    return res.status(404).json({ error: "Command not found" });
  }

  const updated = await prisma.deviceCommand.update({
    where: { id: cmd.id },
    data: {
      status: ok ? "ACKED" : "ERROR",
      ackedAt: new Date(),
      error: ok ? null : (typeof error === "string" ? error : "Device reported error")
    }
  });

  res.json({ ok: true, command: updated });
}
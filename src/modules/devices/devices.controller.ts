import { Request, Response } from "express";
import { prisma } from "../../prisma/client";
import crypto from "crypto";
import bcrypt from "bcrypt";

// ---- Retry/Timeout config ----
const BASE_ACK_TIMEOUT_MS = 30_000; // 30s
const MAX_ACK_TIMEOUT_MS = 5 * 60_000; // 5 min

function ackTimeoutMs(retryCount: number) {
  const rc = Math.max(0, Number.isFinite(retryCount) ? retryCount : 0);
  const ms = BASE_ACK_TIMEOUT_MS * (rc + 1);
  return Math.min(ms, MAX_ACK_TIMEOUT_MS);
}

export async function listDevices(req: Request, res: Response) {
  const user = req.user!;
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
      createdAt: true,
      authType: true,
      clientId: true,
      userId: true,
    },
    orderBy: { createdAt: "desc" },
  });

  res.json(devices);
}

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
      authType: "KEY",
      deviceKeyHash,
      online: false,
      volume: 5,
      muted: false,
    },
    select: { id: true, name: true, tenantId: true, orgUnitId: true, createdAt: true },
  });

  // plaintext kulcsot csak most adjuk vissza!
  res.status(201).json({ device, deviceKey });
}

export async function deviceBeacon(req: Request, res: Response) {
  const dev = (req as any).device as { id: string; tenantId: string };
  const { volume, muted, statusPayload, firmwareVersion } = req.body ?? {};

  const ipAddress =
    (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ||
    req.socket.remoteAddress ||
    null;

  const updated = await prisma.device.update({
    where: { id: dev.id },
    data: {
      online: true,
      lastSeenAt: new Date(),
      ipAddress,
      firmwareVersion: typeof firmwareVersion === "string" ? firmwareVersion : undefined,
      volume: typeof volume === "number" ? volume : undefined,
      muted: typeof muted === "boolean" ? muted : undefined,
      statusPayload: statusPayload ?? undefined,
    },
    select: { id: true, online: true, lastSeenAt: true },
  });

  res.json({ ok: true, device: updated });
}

export async function createDeviceCommand(req: Request, res: Response) {
  const user = req.user!;
  if (user.role !== "TENANT_ADMIN" && user.role !== "ORG_ADMIN") {
    return res.status(403).json({ error: "Forbidden" });
  }

  const deviceId = String(req.params.id);
  const { payload } = req.body ?? {};
  if (!payload || typeof payload !== "object") {
    return res.status(400).json({ error: "payload is required (JSON object)" });
  }

  const device = await prisma.device.findFirst({
    where: { id: deviceId, tenantId: user.tenantId! },
  });
  if (!device) {
    return res.status(404).json({ error: "Device not found" });
  }

  const command = await prisma.deviceCommand.create({
    data: {
      tenantId: user.tenantId!,
      deviceId,
      payload,
      status: "QUEUED",
    },
  });

  res.status(201).json(command);
}

export async function pollCommands(req: Request, res: Response) {
  const dev = (req as any).device as { id: string; tenantId: string };
  const now = new Date();

  const sentList = await prisma.deviceCommand.findMany({
    where: { tenantId: dev.tenantId, deviceId: dev.id, status: "SENT" },
    orderBy: { queuedAt: "asc" },
  });

  if (sentList.length > 1) {
    const toRequeueIds = sentList.slice(1).map((c) => c.id);
    await prisma.deviceCommand.updateMany({
      where: { id: { in: toRequeueIds } },
      data: { status: "QUEUED", sentAt: null, lastError: "Superseded: another command was already in-flight" },
    });
  }

  const inFlight = await prisma.deviceCommand.findFirst({
    where: { tenantId: dev.tenantId, deviceId: dev.id, status: "SENT" },
    orderBy: { sentAt: "asc" },
  });

  if (inFlight) {
    const sentAt = inFlight.sentAt ?? new Date(0);
    const timeoutMs = ackTimeoutMs(inFlight.retryCount);
    const timeoutBefore = new Date(now.getTime() - timeoutMs);

    if (sentAt > timeoutBefore) {
      return res.json({ ok: true, command: null });
    }

    if (inFlight.retryCount < inFlight.maxRetries) {
      const updated = await prisma.deviceCommand.update({
        where: { id: inFlight.id },
        data: { retryCount: { increment: 1 }, sentAt: now, lastError: `Timeout: ACK not received (timeoutMs=${timeoutMs})` },
      });
      return res.json({ ok: true, command: updated });
    }

    await prisma.deviceCommand.update({
      where: { id: inFlight.id },
      data: { status: "FAILED", ackedAt: now, lastError: "Timeout: max retries reached", error: "Timeout: max retries reached" },
    });
  }

  const queued = await prisma.deviceCommand.findFirst({
    where: { tenantId: dev.tenantId, deviceId: dev.id, status: "QUEUED" },
    orderBy: { queuedAt: "asc" },
  });

  if (!queued) {
    return res.json({ ok: true, command: null });
  }

  const updated = await prisma.deviceCommand.updateMany({
    where: { id: queued.id, status: "QUEUED" },
    data: { status: "SENT", sentAt: now },
  });

  if (updated.count === 0) {
    return res.json({ ok: true, command: null });
  }

  const fresh = await prisma.deviceCommand.findUnique({ where: { id: queued.id } });
  return res.json({ ok: true, command: fresh });
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

  const cmd = await prisma.deviceCommand.findFirst({
    where: { id: commandId, tenantId: dev.tenantId, deviceId: dev.id },
  });
  if (!cmd) {
    return res.status(404).json({ error: "Command not found" });
  }

  if (cmd.status === "ACKED" || cmd.status === "FAILED") {
    return res.json({ ok: true, command: cmd, note: "Already finalized" });
  }

  const updated = await prisma.deviceCommand.update({
    where: { id: cmd.id },
    data: {
      status: ok ? "ACKED" : "FAILED",
      ackedAt: new Date(),
      lastError: ok ? null : (typeof error === "string" ? error : "Device reported error"),
      error: ok ? null : (typeof error === "string" ? error : "Device reported error"),
    },
  });

  return res.json({ ok: true, command: updated });
}
import { Request, Response } from "express";
import { prisma } from "../../prisma/client";
import crypto from "crypto";
import bcrypt from "bcrypt";

// ---- Retry/Timeout config ----
// Base ACK timeout (első próbálkozásnál ennyi ideig várunk ACK-ra)
const BASE_ACK_TIMEOUT_MS = 30_000; // 30s (később .env)
// Felső korlát, nehogy végtelenre nőjön (pl. 5 perc)
const MAX_ACK_TIMEOUT_MS = 5 * 60_000; // 5 min

// Lineáris backoff: 30s, 60s, 90s, 120s...
function ackTimeoutMs(retryCount: number) {
  const rc = Math.max(0, Number.isFinite(retryCount) ? retryCount : 0);
  const ms = BASE_ACK_TIMEOUT_MS * (rc + 1);
  return Math.min(ms, MAX_ACK_TIMEOUT_MS);
}

// (Ha később exponenciális kell, erre cseréld)
// function ackTimeoutMs(retryCount: number) {
//   const rc = Math.max(0, Number.isFinite(retryCount) ? retryCount : 0);
//   const ms = BASE_ACK_TIMEOUT_MS * Math.pow(2, rc);
//   return Math.min(ms, MAX_ACK_TIMEOUT_MS);
// }

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
      // retryCount/maxRetries defaultból jön
    }
  });

  res.status(201).json(command);
}

export async function pollCommands(req: Request, res: Response) {
  const dev = (req as any).device as { id: string; tenantId: string };
  const now = new Date();

  // 0) Safety net: ha valamiért több SENT van ugyanarra a device-ra,
  //    akkor csak a legrégebbit hagyjuk "in-flight"-nak, a többit visszatesszük QUEUED-ba.
  const sentList = await prisma.deviceCommand.findMany({
    where: {
      tenantId: dev.tenantId,
      deviceId: dev.id,
      status: "SENT"
    },
    orderBy: { queuedAt: "asc" }
  });

  if (sentList.length > 1) {
    const keep = sentList[0]; // ezt hagyjuk meg in-flightnak
    void keep; // csak dokumentációs célból: keep az in-flight, nem használjuk tovább itt

    const toRequeueIds = sentList.slice(1).map(c => c.id);
    await prisma.deviceCommand.updateMany({
      where: { id: { in: toRequeueIds } },
      data: {
        status: "QUEUED",
        sentAt: null,
        lastError: "Superseded: another command was already in-flight"
      }
    });
  }

  // 1) Ha van in-flight (SENT) parancs, akkor azt kezeljük először.
  //    - ha még nem timeoutos: NEM adunk újat
  //    - ha timeoutos és van még retry: újraküldjük (retryCount++)
  //    - ha elfogyott a retry: FAILED és mehetünk tovább a következő QUEUED-ra
  const inFlight = await prisma.deviceCommand.findFirst({
    where: {
      tenantId: dev.tenantId,
      deviceId: dev.id,
      status: "SENT"
    },
    orderBy: { sentAt: "asc" }
  });

  if (inFlight) {
    // ha sentAt null lenne (nem kéne), kezeljük úgy, mintha "nagyon régi" lenne
    const sentAt = inFlight.sentAt ?? new Date(0);

    // ✅ Dinamikus timeout retryCount alapján (backoff)
    const timeoutMs = ackTimeoutMs(inFlight.retryCount);
    const timeoutBefore = new Date(now.getTime() - timeoutMs);

    if (sentAt > timeoutBefore) {
      // még várunk ACK-ra, nem küldünk másik parancsot
      return res.json({ ok: true, command: null });
    }

    // timeout -> retry vagy fail
    if (inFlight.retryCount < inFlight.maxRetries) {
      const updated = await prisma.deviceCommand.update({
        where: { id: inFlight.id },
        data: {
          retryCount: { increment: 1 },
          sentAt: now,
          lastError: `Timeout: ACK not received (timeoutMs=${timeoutMs})`
        }
      });
      return res.json({ ok: true, command: updated });
    }

    // max retry elérve -> FAILED és továbblépünk
    await prisma.deviceCommand.update({
      where: { id: inFlight.id },
      data: {
        status: "FAILED",
        ackedAt: now,
        lastError: "Timeout: max retries reached",
        error: "Timeout: max retries reached"
      }
    });
    // és folytatjuk lent a QUEUED-dal
  }

  // 2) Nincs in-flight -> a legrégebbi QUEUED-ot kiküldjük
  const queued = await prisma.deviceCommand.findFirst({
    where: {
      tenantId: dev.tenantId,
      deviceId: dev.id,
      status: "QUEUED"
    },
    orderBy: { queuedAt: "asc" }
  });

  if (!queued) {
    return res.json({ ok: true, command: null });
  }

  // atomi átállítás QUEUED -> SENT (race ellen)
  const updated = await prisma.deviceCommand.updateMany({
    where: { id: queued.id, status: "QUEUED" },
    data: { status: "SENT", sentAt: now }
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

  // idempotencia: ha már ACKED/FAILED, akkor csak visszaadjuk
  if (cmd.status === "ACKED" || cmd.status === "FAILED") {
    return res.json({ ok: true, command: cmd, note: "Already finalized" });
  }

  const updated = await prisma.deviceCommand.update({
    where: { id: cmd.id },
    data: {
      status: ok ? "ACKED" : "FAILED",
      ackedAt: new Date(),
      lastError: ok ? null : (typeof error === "string" ? error : "Device reported error"),
      error: ok ? null : (typeof error === "string" ? error : "Device reported error")
    }
  });

  return res.json({ ok: true, command: updated });
}
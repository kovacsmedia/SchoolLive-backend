// src/modules/player/player.device.controller.ts

import { Request, Response } from "express";
import { prisma } from "../../prisma/client";

type JwtUser = { sub?: string; role?: string; tenantId?: string | null };

function getUser(req: Request): JwtUser {
  return (req as any).user as JwtUser;
}
function getTenantId(req: Request): string {
  return (req as any).tenantId as string;
}

// ─── POST /player/device/register ─────────────────────────────────────────
//
// Player auto-aktiválás: ha egy tenant PLAYER-szerepű user-t hoz létre, akkor
// az általa indított webplayer az első belépéskor AZONNAL kapjon Device-rekordot
// (admin-jóváhagyás nélkül). A PLAYER-szerep maga az aktiválás.
//
// Hagyományos eszközöknél (ESP/Android/Linux/Windows) megmarad a deviceKey +
// admin-approval flow – azokat a /devices/provision és /admin/devices/* útvonalak
// kezelik, nem ez.
//
// Idempotens: egy userId+tenantId párhoz egy Device. Második böngészőből
// belépve ugyanazt a Device-rekordot kapja vissza, csak frissítjük az
// online/ipAddress/lastSeenAt-t.
export async function registerPlayerDevice(req: Request, res: Response) {
  try {
    const user     = getUser(req);
    const tenantId = getTenantId(req);
    const userId   = user.sub;

    if (!userId) return res.status(401).json({ error: "Missing user id" });
    if (user.role !== "PLAYER") return res.status(403).json({ error: "Only PLAYER role can register" });

    const { clientId, ipAddress } = req.body ?? {};
    if (!clientId) return res.status(400).json({ error: "clientId is required" });

    const mac = `WP-${clientId}`;
    const loginTime = new Date();

    // Ha már van Device ehhez a userId+tenantId-hez → csak frissítjük.
    const existingDevice = await prisma.device.findFirst({
      where: { userId, tenantId },
      select: { id: true, name: true, online: true },
    });

    if (existingDevice) {
      // Lejárt/elmulasztott QUEUED parancsok törlése bejelentkezéskor.
      const pendingCmds = await prisma.deviceCommand.findMany({
        where: { deviceId: existingDevice.id, status: "QUEUED" },
        select: { id: true, payload: true, queuedAt: true },
      });

      const staleIds: string[] = [];
      for (const cmd of pendingCmds) {
        const p = cmd.payload as any;
        const scheduledAt = p?.scheduledAt ? new Date(p.scheduledAt) : null;
        if (scheduledAt && scheduledAt > loginTime) continue;
        staleIds.push(cmd.id);
      }

      if (staleIds.length > 0) {
        await prisma.deviceCommand.deleteMany({ where: { id: { in: staleIds } } });
        console.log(`[PLAYER] 🗑 ${staleIds.length} elmulasztott parancs törölve (device: ${existingDevice.id})`);
      }

      await prisma.device.update({
        where: { id: existingDevice.id },
        data: {
          clientId,
          ipAddress: ipAddress ?? undefined,
          lastSeenAt: loginTime,
          online: true,
        },
      });
      return res.json({ ok: true, status: "active", deviceId: existingDevice.id });
    }

    // Még nincs Device → automatikusan létrehozzuk. A PLAYER-szerep maga a
    // jogosultság (nem kell admin-jóváhagyás). Név alapja a User displayName-je
    // (ha nincs, az email). Ütközéskor (két PLAYER ugyanazzal a displayName-mel
    // ugyanazon tenant alatt) emailre fallback-elünk, ami User-szinten globálisan
    // unique.
    const owner = await prisma.user.findUnique({
      where: { id: userId },
      select: { email: true, displayName: true },
    });
    if (!owner) {
      console.warn(`[PLAYER] register: user nem található (userId=${userId})`);
      return res.status(404).json({ error: "User not found" });
    }

    const friendly  = owner.displayName?.trim() || owner.email.split("@")[0];
    const primary   = `Webplayer – ${friendly}`;
    const fallback  = `Webplayer – ${owner.email}`;

    let created: { id: string } | null = null;
    for (const candidateName of [primary, fallback]) {
      try {
        created = await prisma.device.create({
          data: {
            tenantId,
            userId,
            clientId,
            name:            candidateName,
            authType:        "JWT",
            firmwareVersion: "WP",
            ipAddress:       ipAddress ?? undefined,
            hwModel:         null,
            online:          true,
            lastSeenAt:      loginTime,
            volume:          5,
            muted:           false,
            syncOffsetMs:    0,
          },
          select: { id: true },
        });
        break;
      } catch (e: any) {
        // P2002 = unique constraint (tenantId+name vagy tenantId+clientId).
        // Először a primary nevet próbáljuk, aztán a fallback-emailt; ha mindkettő
        // ütközik, az kivételes (két PLAYER user pontosan ugyanazzal az emaillel
        // egy tenant alatt nem fordulhat elő, mert email globálisan unique).
        if (e?.code !== "P2002") throw e;
        console.warn(
          `[PLAYER] register: Device name ütközés "${candidateName}", próbálkozás fallback névvel`
        );
      }
    }

    if (!created) {
      console.error(`[PLAYER] register: Device-create sikertelen userId=${userId}`);
      return res.status(500).json({ error: "Failed to create webplayer device" });
    }

    // Régi PendingDevice rekord kitakarítása (ha még maradt a régi flow-ból).
    await prisma.pendingDevice.deleteMany({ where: { mac } }).catch(() => {});

    console.log(`[PLAYER] ✅ Webplayer auto-aktiválva: device=${created.id} user=${userId} tenant=${tenantId}`);

    return res.json({ ok: true, status: "active", deviceId: created.id });
  } catch (err) {
    console.error("[PLAYER] register error:", err);
    return res.status(500).json({ error: "Registration failed" });
  }
}

// ─── POST /player/device/beacon ───────────────────────────────────────────
export async function beaconPlayerDevice(req: Request, res: Response) {
  try {
    const user     = getUser(req);
    const tenantId = getTenantId(req);
    const userId   = user.sub;

    if (!userId) return res.status(401).json({ error: "Missing user id" });

    const { ipAddress } = req.body ?? {};

    const device = await prisma.device.findFirst({
      where: { userId, tenantId },
      select: { id: true },
    });

    if (!device) {
      // Még pending – frissítjük a lastSeenAt-t
      const { clientId } = req.body ?? {};
      if (clientId) {
        const mac = `WP-${clientId}`;
        await prisma.pendingDevice.updateMany({
          where: { mac },
          data: { lastSeenAt: new Date(), ipAddress: ipAddress ?? undefined },
        });
      }
      return res.json({ ok: true, status: "pending" });
    }

    await prisma.device.update({
      where: { id: device.id },
      data: {
        online:     true,
        lastSeenAt: new Date(),
        ipAddress:  ipAddress ?? undefined,
      },
    });

    return res.json({
      ok: true,
      status: "active",
      device: { id: device.id, online: true, lastSeenAt: new Date() },
    });
  } catch (err) {
    console.error("[PLAYER] beacon error:", err);
    return res.status(500).json({ error: "Beacon failed" });
  }
}

// ─── POST /player/device/poll ─────────────────────────────────────────────
export async function pollPlayerCommands(req: Request, res: Response) {
  try {
    const user     = getUser(req);
    const tenantId = getTenantId(req);
    const userId   = user.sub;

    if (!userId) return res.status(401).json({ error: "Missing user id" });

    const device = await prisma.device.findFirst({
      where: { userId, tenantId },
      select: { id: true, name: true },
    });

    if (!device) {
      return res.json({ ok: true, status: "pending", command: null });
    }

    // Online státusz frissítése
    await prisma.device.update({
      where: { id: device.id },
      data: { online: true, lastSeenAt: new Date() },
    });

    // Következő QUEUED parancs lekérése – scheduledAt-et tiszteljük
    const queued = await prisma.deviceCommand.findMany({
      where: { deviceId: device.id, status: "QUEUED" },
      orderBy: { queuedAt: "asc" },
      take: 20,
    });

    const now = new Date();
    const STALE_MS = 90_000; // 90 másodpercnél régebbi azonnali parancs → elavult

    // Elavult parancsok azonosítása és törlése
    const staleInPoll: string[] = [];
    for (const cmd of queued) {
      const p = cmd.payload as any;
      const scheduledAt = p?.scheduledAt ? new Date(p.scheduledAt) : null;
      if (scheduledAt) {
        // Jövőbeli → OK; már elmúlt scheduledAt → elavult
        if (scheduledAt > now) continue;
        const overdueSec = (now.getTime() - scheduledAt.getTime()) / 1000;
        if (overdueSec > 120) { staleInPoll.push(cmd.id); } // 2 percnél régebbi időzített
      } else {
        // Azonnali parancs: ha több mint 90mp-je vár → elavult
        const ageSec = (now.getTime() - cmd.queuedAt.getTime()) / 1000;
        if (ageSec > STALE_MS / 1000) { staleInPoll.push(cmd.id); }
      }
    }
    if (staleInPoll.length > 0) {
      await prisma.deviceCommand.deleteMany({
        where: { id: { in: staleInPoll } },
      });
      console.log(`[PLAYER] ⏭ ${staleInPoll.length} elavult parancs törölve poll-ban`);
    }

    const freshQueued = queued.filter(cmd => !staleInPoll.includes(cmd.id));
    const command = freshQueued.find(cmd => {
      const p = cmd.payload as any;
      if (!p?.scheduledAt) return true; // azonnali
      return new Date(p.scheduledAt) <= now;
    }) ?? null;

    if (command) {
      await prisma.deviceCommand.update({
        where: { id: command.id },
        data: { status: "SENT", sentAt: new Date() },
      });
    }

    return res.json({
      ok: true,
      status: "active",
      command: command
        ? { id: command.id, payload: command.payload }
        : null,
    });
  } catch (err) {
    console.error("[PLAYER] poll error:", err);
    return res.status(500).json({ error: "Poll failed" });
  }
}

// ─── POST /player/device/ack ──────────────────────────────────────────────
export async function ackPlayerCommand(req: Request, res: Response) {
  try {
    const user     = getUser(req);
    const tenantId = getTenantId(req);
    const userId   = user.sub;

    if (!userId) return res.status(401).json({ error: "Missing user id" });

    const { commandId } = req.body ?? {};
    if (!commandId) return res.status(400).json({ error: "commandId is required" });

    const device = await prisma.device.findFirst({
      where: { userId, tenantId },
      select: { id: true },
    });

    if (!device) return res.status(404).json({ error: "Device not found" });

    const command = await prisma.deviceCommand.findFirst({
      where: { id: String(commandId), deviceId: device.id },
    });

    if (!command) return res.status(404).json({ error: "Command not found" });

    await prisma.deviceCommand.update({
      where: { id: command.id },
      data: { status: "ACKED", ackedAt: new Date() },
    });

    return res.json({ ok: true, command: { id: command.id } });
  } catch (err) {
    console.error("[PLAYER] ack error:", err);
    return res.status(500).json({ error: "Ack failed" });
  }
}
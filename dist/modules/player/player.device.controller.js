"use strict";
// src/modules/player/player.device.controller.ts
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerPlayerDevice = registerPlayerDevice;
exports.beaconPlayerDevice = beaconPlayerDevice;
exports.pollPlayerCommands = pollPlayerCommands;
exports.ackPlayerCommand = ackPlayerCommand;
const client_1 = require("../../prisma/client");
function getUser(req) {
    return req.user;
}
function getTenantId(req) {
    return req.tenantId;
}
// ─── POST /player/device/register ─────────────────────────────────────────
// Első belépéskor létrehoz PendingDevice rekordot (vagy frissíti)
async function registerPlayerDevice(req, res) {
    try {
        const user = getUser(req);
        const tenantId = getTenantId(req);
        const userId = user.sub;
        if (!userId)
            return res.status(401).json({ error: "Missing user id" });
        if (user.role !== "PLAYER")
            return res.status(403).json({ error: "Only PLAYER role can register" });
        const { clientId, ipAddress, userAgent } = req.body ?? {};
        if (!clientId)
            return res.status(400).json({ error: "clientId is required" });
        const mac = `WP-${clientId}`;
        // Ha már van aktív Device ehhez a userId-hoz → nem kell pending
        const existingDevice = await client_1.prisma.device.findFirst({
            where: { userId, tenantId },
            select: { id: true, name: true, online: true },
        });
        if (existingDevice) {
            const loginTime = new Date();
            // Lejárt/elmulasztott QUEUED parancsok törlése bejelentkezéskor
            // Az összes QUEUED parancsot lekérjük és azokat töröljük, amik nem jövőbeliek
            const pendingCmds = await client_1.prisma.deviceCommand.findMany({
                where: { deviceId: existingDevice.id, status: "QUEUED" },
                select: { id: true, payload: true, queuedAt: true },
            });
            const staleIds = [];
            for (const cmd of pendingCmds) {
                const p = cmd.payload;
                const scheduledAt = p?.scheduledAt ? new Date(p.scheduledAt) : null;
                // Megtartjuk: jövőbeli scheduledAt (még nem érkezett el az ideje)
                if (scheduledAt && scheduledAt > loginTime)
                    continue;
                // Töröljük: azonnali vagy már elmúlt scheduledAt → a player lemaradt róluk
                staleIds.push(cmd.id);
            }
            if (staleIds.length > 0) {
                await client_1.prisma.deviceCommand.deleteMany({
                    where: { id: { in: staleIds } },
                });
                console.log(`[PLAYER] 🗑 ${staleIds.length} elmulasztott parancs törölve (device: ${existingDevice.id})`);
            }
            // Online státusz frissítése
            await client_1.prisma.device.update({
                where: { id: existingDevice.id },
                data: {
                    ipAddress: ipAddress ?? undefined,
                    lastSeenAt: loginTime,
                    online: true,
                },
            });
            return res.json({ ok: true, status: "active", deviceId: existingDevice.id });
        }
        // Nincs még Device → PendingDevice upsert
        await client_1.prisma.pendingDevice.upsert({
            where: { mac },
            update: {
                ipAddress: ipAddress ?? null,
                userAgent: userAgent ?? null,
                lastSeenAt: new Date(),
                clientId,
                userId,
            },
            create: {
                mac,
                ipAddress: ipAddress ?? null,
                userAgent: userAgent ?? null,
                firmwareVersion: "WP",
                clientId,
                userId,
                firstSeenAt: new Date(),
                lastSeenAt: new Date(),
            },
        });
        return res.json({ ok: true, status: "pending" });
    }
    catch (err) {
        console.error("[PLAYER] register error:", err);
        return res.status(500).json({ error: "Registration failed" });
    }
}
// ─── POST /player/device/beacon ───────────────────────────────────────────
async function beaconPlayerDevice(req, res) {
    try {
        const user = getUser(req);
        const tenantId = getTenantId(req);
        const userId = user.sub;
        if (!userId)
            return res.status(401).json({ error: "Missing user id" });
        const { ipAddress } = req.body ?? {};
        const device = await client_1.prisma.device.findFirst({
            where: { userId, tenantId },
            select: { id: true },
        });
        if (!device) {
            // Még pending – frissítjük a lastSeenAt-t
            const { clientId } = req.body ?? {};
            if (clientId) {
                const mac = `WP-${clientId}`;
                await client_1.prisma.pendingDevice.updateMany({
                    where: { mac },
                    data: { lastSeenAt: new Date(), ipAddress: ipAddress ?? undefined },
                });
            }
            return res.json({ ok: true, status: "pending" });
        }
        await client_1.prisma.device.update({
            where: { id: device.id },
            data: {
                online: true,
                lastSeenAt: new Date(),
                ipAddress: ipAddress ?? undefined,
            },
        });
        return res.json({
            ok: true,
            status: "active",
            device: { id: device.id, online: true, lastSeenAt: new Date() },
        });
    }
    catch (err) {
        console.error("[PLAYER] beacon error:", err);
        return res.status(500).json({ error: "Beacon failed" });
    }
}
// ─── POST /player/device/poll ─────────────────────────────────────────────
async function pollPlayerCommands(req, res) {
    try {
        const user = getUser(req);
        const tenantId = getTenantId(req);
        const userId = user.sub;
        if (!userId)
            return res.status(401).json({ error: "Missing user id" });
        const device = await client_1.prisma.device.findFirst({
            where: { userId, tenantId },
            select: { id: true, name: true },
        });
        if (!device) {
            return res.json({ ok: true, status: "pending", command: null });
        }
        // Online státusz frissítése
        await client_1.prisma.device.update({
            where: { id: device.id },
            data: { online: true, lastSeenAt: new Date() },
        });
        // Következő QUEUED parancs lekérése – scheduledAt-et tiszteljük
        const queued = await client_1.prisma.deviceCommand.findMany({
            where: { deviceId: device.id, status: "QUEUED" },
            orderBy: { queuedAt: "asc" },
            take: 20,
        });
        const now = new Date();
        const STALE_MS = 90_000; // 90 másodpercnél régebbi azonnali parancs → elavult
        // Elavult parancsok azonosítása és törlése
        const staleInPoll = [];
        for (const cmd of queued) {
            const p = cmd.payload;
            const scheduledAt = p?.scheduledAt ? new Date(p.scheduledAt) : null;
            if (scheduledAt) {
                // Jövőbeli → OK; már elmúlt scheduledAt → elavult
                if (scheduledAt > now)
                    continue;
                const overdueSec = (now.getTime() - scheduledAt.getTime()) / 1000;
                if (overdueSec > 120) {
                    staleInPoll.push(cmd.id);
                } // 2 percnél régebbi időzített
            }
            else {
                // Azonnali parancs: ha több mint 90mp-je vár → elavult
                const ageSec = (now.getTime() - cmd.queuedAt.getTime()) / 1000;
                if (ageSec > STALE_MS / 1000) {
                    staleInPoll.push(cmd.id);
                }
            }
        }
        if (staleInPoll.length > 0) {
            await client_1.prisma.deviceCommand.deleteMany({
                where: { id: { in: staleInPoll } },
            });
            console.log(`[PLAYER] ⏭ ${staleInPoll.length} elavult parancs törölve poll-ban`);
        }
        const freshQueued = queued.filter(cmd => !staleInPoll.includes(cmd.id));
        const command = freshQueued.find(cmd => {
            const p = cmd.payload;
            if (!p?.scheduledAt)
                return true; // azonnali
            return new Date(p.scheduledAt) <= now;
        }) ?? null;
        if (command) {
            await client_1.prisma.deviceCommand.update({
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
    }
    catch (err) {
        console.error("[PLAYER] poll error:", err);
        return res.status(500).json({ error: "Poll failed" });
    }
}
// ─── POST /player/device/ack ──────────────────────────────────────────────
async function ackPlayerCommand(req, res) {
    try {
        const user = getUser(req);
        const tenantId = getTenantId(req);
        const userId = user.sub;
        if (!userId)
            return res.status(401).json({ error: "Missing user id" });
        const { commandId } = req.body ?? {};
        if (!commandId)
            return res.status(400).json({ error: "commandId is required" });
        const device = await client_1.prisma.device.findFirst({
            where: { userId, tenantId },
            select: { id: true },
        });
        if (!device)
            return res.status(404).json({ error: "Device not found" });
        const command = await client_1.prisma.deviceCommand.findFirst({
            where: { id: String(commandId), deviceId: device.id },
        });
        if (!command)
            return res.status(404).json({ error: "Command not found" });
        await client_1.prisma.deviceCommand.update({
            where: { id: command.id },
            data: { status: "ACKED", ackedAt: new Date() },
        });
        return res.json({ ok: true, command: { id: command.id } });
    }
    catch (err) {
        console.error("[PLAYER] ack error:", err);
        return res.status(500).json({ error: "Ack failed" });
    }
}

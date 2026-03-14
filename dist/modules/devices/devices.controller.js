"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.listDevices = listDevices;
exports.registerDevice = registerDevice;
exports.deviceBeacon = deviceBeacon;
exports.createDeviceCommand = createDeviceCommand;
exports.pollCommands = pollCommands;
exports.ackCommand = ackCommand;
exports.playerPollCommands = playerPollCommands;
exports.playerAckCommand = playerAckCommand;
const client_1 = require("../../prisma/client");
const crypto_1 = __importDefault(require("crypto"));
const bcrypt_1 = __importDefault(require("bcrypt"));
// ---- Retry/Timeout config ----
const BASE_ACK_TIMEOUT_MS = 30_000;
const MAX_ACK_TIMEOUT_MS = 5 * 60_000;
function ackTimeoutMs(retryCount) {
    const rc = Math.max(0, Number.isFinite(retryCount) ? retryCount : 0);
    const ms = BASE_ACK_TIMEOUT_MS * (rc + 1);
    return Math.min(ms, MAX_ACK_TIMEOUT_MS);
}
async function listDevices(req, res) {
    const user = req.user;
    if (user.role === "SUPER_ADMIN") {
        return res.json({ note: "SUPER_ADMIN has no tenant context. Use a tenant user to list devices." });
    }
    const devices = await client_1.prisma.device.findMany({
        where: { tenantId: user.tenantId },
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
async function registerDevice(req, res) {
    const user = req.user;
    if (user.role !== "TENANT_ADMIN" && user.role !== "ORG_ADMIN") {
        return res.status(403).json({ error: "Forbidden" });
    }
    const { name, orgUnitId } = req.body ?? {};
    if (!name || typeof name !== "string") {
        return res.status(400).json({ error: "name is required" });
    }
    const deviceKey = crypto_1.default.randomBytes(24).toString("hex");
    const deviceKeyHash = await bcrypt_1.default.hash(deviceKey, 10);
    const device = await client_1.prisma.device.create({
        data: {
            tenantId: user.tenantId,
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
    res.status(201).json({ device, deviceKey });
}
async function deviceBeacon(req, res) {
    const dev = req.device;
    const { volume, muted, statusPayload, firmwareVersion } = req.body ?? {};
    const ipAddress = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
        req.socket.remoteAddress ||
        null;
    const updated = await client_1.prisma.device.update({
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
async function createDeviceCommand(req, res) {
    const user = req.user;
    if (user.role !== "TENANT_ADMIN" && user.role !== "ORG_ADMIN") {
        return res.status(403).json({ error: "Forbidden" });
    }
    const deviceId = String(req.params.id);
    const { payload } = req.body ?? {};
    if (!payload || typeof payload !== "object") {
        return res.status(400).json({ error: "payload is required (JSON object)" });
    }
    const device = await client_1.prisma.device.findFirst({
        where: { id: deviceId, tenantId: user.tenantId },
    });
    if (!device) {
        return res.status(404).json({ error: "Device not found" });
    }
    const command = await client_1.prisma.deviceCommand.create({
        data: {
            tenantId: user.tenantId,
            deviceId,
            payload,
            status: "QUEUED",
        },
    });
    res.status(201).json(command);
}
async function pollCommands(req, res) {
    const dev = req.device;
    const now = new Date();
    const sentList = await client_1.prisma.deviceCommand.findMany({
        where: { tenantId: dev.tenantId, deviceId: dev.id, status: "SENT" },
        orderBy: { queuedAt: "asc" },
    });
    if (sentList.length > 1) {
        const toRequeueIds = sentList.slice(1).map((c) => c.id);
        await client_1.prisma.deviceCommand.updateMany({
            where: { id: { in: toRequeueIds } },
            data: { status: "QUEUED", sentAt: null, lastError: "Superseded: another command was already in-flight" },
        });
    }
    const inFlight = await client_1.prisma.deviceCommand.findFirst({
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
            const updated = await client_1.prisma.deviceCommand.update({
                where: { id: inFlight.id },
                data: { retryCount: { increment: 1 }, sentAt: now, lastError: `Timeout: ACK not received (timeoutMs=${timeoutMs})` },
            });
            return res.json({ ok: true, command: updated });
        }
        await client_1.prisma.deviceCommand.update({
            where: { id: inFlight.id },
            data: { status: "FAILED", ackedAt: now, lastError: "Timeout: max retries reached", error: "Timeout: max retries reached" },
        });
    }
    const queued = await client_1.prisma.deviceCommand.findFirst({
        where: { tenantId: dev.tenantId, deviceId: dev.id, status: "QUEUED" },
        orderBy: { queuedAt: "asc" },
    });
    if (!queued) {
        return res.json({ ok: true, command: null });
    }
    const updated = await client_1.prisma.deviceCommand.updateMany({
        where: { id: queued.id, status: "QUEUED" },
        data: { status: "SENT", sentAt: now },
    });
    if (updated.count === 0) {
        return res.json({ ok: true, command: null });
    }
    const fresh = await client_1.prisma.deviceCommand.findUnique({ where: { id: queued.id } });
    return res.json({ ok: true, command: fresh });
}
async function ackCommand(req, res) {
    const dev = req.device;
    const { commandId, ok, error } = req.body ?? {};
    if (!commandId || typeof commandId !== "string") {
        return res.status(400).json({ error: "commandId is required" });
    }
    if (typeof ok !== "boolean") {
        return res.status(400).json({ error: "ok is required (boolean)" });
    }
    const cmd = await client_1.prisma.deviceCommand.findFirst({
        where: { id: commandId, tenantId: dev.tenantId, deviceId: dev.id },
    });
    if (!cmd) {
        return res.status(404).json({ error: "Command not found" });
    }
    if (cmd.status === "ACKED" || cmd.status === "FAILED") {
        return res.json({ ok: true, command: cmd, note: "Already finalized" });
    }
    const updated = await client_1.prisma.deviceCommand.update({
        where: { id: cmd.id },
        data: {
            status: ok ? "ACKED" : "FAILED",
            ackedAt: new Date(),
            lastError: ok ? null : (typeof error === "string" ? error : "Device reported error"),
            error: ok ? null : (typeof error === "string" ? error : "Device reported error"),
        },
    });
    // Ha sikeres ACK és van messageId, frissítjük a Message.playedAt-et
    if (ok && cmd.messageId) {
        await client_1.prisma.message.update({
            where: { id: cmd.messageId },
            data: { playedAt: new Date() },
        }).catch(() => { });
    }
    return res.json({ ok: true, command: updated });
}
async function playerPollCommands(req, res) {
    const user = req.user;
    if (!user)
        return res.status(401).json({ ok: false, error: "UNAUTHORIZED" });
    if (user.role !== "PLAYER")
        return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    const { clientId } = req.body ?? {};
    if (!clientId || typeof clientId !== "string") {
        return res.status(400).json({ ok: false, error: "clientId is required" });
    }
    if (!user.tenantId) {
        return res.status(400).json({ ok: false, error: "TENANT_CONTEXT_REQUIRED" });
    }
    const device = await client_1.prisma.device.findFirst({
        where: {
            tenantId: user.tenantId,
            authType: "JWT",
            userId: user.sub,
            clientId,
        },
        select: { id: true, tenantId: true },
    });
    if (!device) {
        return res.status(404).json({ ok: false, error: "DEVICE_NOT_REGISTERED" });
    }
    await client_1.prisma.device.update({
        where: { id: device.id },
        data: { online: true, lastSeenAt: new Date() },
    });
    const dev = { id: device.id, tenantId: device.tenantId };
    const now = new Date();
    const sentList = await client_1.prisma.deviceCommand.findMany({
        where: { tenantId: dev.tenantId, deviceId: dev.id, status: "SENT" },
        orderBy: { queuedAt: "asc" },
    });
    if (sentList.length > 1) {
        const toRequeueIds = sentList.slice(1).map((c) => c.id);
        await client_1.prisma.deviceCommand.updateMany({
            where: { id: { in: toRequeueIds } },
            data: { status: "QUEUED", sentAt: null, lastError: "Superseded: another command was already in-flight" },
        });
    }
    const inFlight = await client_1.prisma.deviceCommand.findFirst({
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
            const updated = await client_1.prisma.deviceCommand.update({
                where: { id: inFlight.id },
                data: { retryCount: { increment: 1 }, sentAt: now, lastError: `Timeout: ACK not received (timeoutMs=${timeoutMs})` },
            });
            return res.json({ ok: true, command: updated });
        }
        await client_1.prisma.deviceCommand.update({
            where: { id: inFlight.id },
            data: { status: "FAILED", ackedAt: now, lastError: "Timeout: max retries reached", error: "Timeout: max retries reached" },
        });
    }
    const queued = await client_1.prisma.deviceCommand.findFirst({
        where: { tenantId: dev.tenantId, deviceId: dev.id, status: "QUEUED" },
        orderBy: { queuedAt: "asc" },
    });
    if (!queued) {
        return res.json({ ok: true, command: null });
    }
    const updatedCount = await client_1.prisma.deviceCommand.updateMany({
        where: { id: queued.id, status: "QUEUED" },
        data: { status: "SENT", sentAt: now },
    });
    if (updatedCount.count === 0) {
        return res.json({ ok: true, command: null });
    }
    const fresh = await client_1.prisma.deviceCommand.findUnique({ where: { id: queued.id } });
    return res.json({ ok: true, command: fresh });
}
async function playerAckCommand(req, res) {
    const user = req.user;
    if (!user)
        return res.status(401).json({ ok: false, error: "UNAUTHORIZED" });
    if (user.role !== "PLAYER")
        return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    const { clientId, commandId, ok, error } = req.body ?? {};
    if (!clientId || typeof clientId !== "string") {
        return res.status(400).json({ ok: false, error: "clientId is required" });
    }
    if (!commandId || typeof commandId !== "string") {
        return res.status(400).json({ ok: false, error: "commandId is required" });
    }
    if (typeof ok !== "boolean") {
        return res.status(400).json({ ok: false, error: "ok is required (boolean)" });
    }
    if (!user.tenantId) {
        return res.status(400).json({ ok: false, error: "TENANT_CONTEXT_REQUIRED" });
    }
    const device = await client_1.prisma.device.findFirst({
        where: {
            tenantId: user.tenantId,
            authType: "JWT",
            userId: user.sub,
            clientId,
        },
        select: { id: true, tenantId: true },
    });
    if (!device) {
        return res.status(404).json({ ok: false, error: "DEVICE_NOT_REGISTERED" });
    }
    const cmd = await client_1.prisma.deviceCommand.findFirst({
        where: { id: commandId, tenantId: device.tenantId, deviceId: device.id },
    });
    if (!cmd) {
        return res.status(404).json({ ok: false, error: "COMMAND_NOT_FOUND" });
    }
    if (cmd.status === "ACKED" || cmd.status === "FAILED") {
        return res.json({ ok: true, command: cmd, note: "Already finalized" });
    }
    const updated = await client_1.prisma.deviceCommand.update({
        where: { id: cmd.id },
        data: {
            status: ok ? "ACKED" : "FAILED",
            ackedAt: new Date(),
            lastError: ok ? null : (typeof error === "string" ? error : "Player reported error"),
            error: ok ? null : (typeof error === "string" ? error : "Player reported error"),
        },
    });
    // Ha sikeres ACK és van messageId, frissítjük a Message.playedAt-et
    if (ok && cmd.messageId) {
        await client_1.prisma.message.update({
            where: { id: cmd.messageId },
            data: { playedAt: new Date() },
        }).catch(() => { });
    }
    await client_1.prisma.device.update({
        where: { id: device.id },
        data: { online: true, lastSeenAt: new Date() },
    });
    return res.json({ ok: true, command: updated });
}

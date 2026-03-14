"use strict";
// src/modules/messages/messages.routes.ts
//
// Dispatch stratégia:
//   - Azonnali: SyncEngine (online) + DB queue (offline)
//   - Ütemezett: csak DB queue
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const client_1 = require("../../prisma/client");
const authJwt_1 = require("../../middleware/authJwt");
const tenant_1 = require("../../middleware/tenant");
const tts_service_1 = require("../../services/tts.service");
const SyncEngine_1 = require("../../sync/SyncEngine");
const router = (0, express_1.Router)();
function tenantId(req) { return req.tenantId; }
function userId(req) { return req.user?.sub; }
// GET /messages
router.get("/", authJwt_1.authJwt, tenant_1.requireTenant, async (req, res) => {
    try {
        const tid = tenantId(req);
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const limit = Math.min(50, parseInt(req.query.limit) || 20);
        const skip = (page - 1) * limit;
        const createdBy = req.query.createdBy;
        const where = { tenantId: tid, ...(createdBy ? { createdById: createdBy } : {}) };
        const [messages, total] = await Promise.all([
            client_1.prisma.message.findMany({
                where, orderBy: { createdAt: "desc" }, skip, take: limit,
                select: {
                    id: true, title: true, text: true, type: true, voice: true,
                    fileUrl: true, targetType: true, targetId: true,
                    scheduledAt: true, playedAt: true, createdAt: true,
                    createdBy: { select: { id: true, displayName: true, email: true } },
                },
            }),
            client_1.prisma.message.count({ where }),
        ]);
        return res.json({ ok: true, messages, total, page, limit });
    }
    catch (err) {
        console.error(err);
        return res.status(500).json({ error: "Failed to fetch messages" });
    }
});
// GET /messages/templates
router.get("/templates", authJwt_1.authJwt, tenant_1.requireTenant, async (req, res) => {
    try {
        const templates = await client_1.prisma.messageTemplate.findMany({
            where: { tenantId: tenantId(req), userId: userId(req) },
            orderBy: { createdAt: "desc" },
            select: { id: true, name: true, text: true, voice: true, createdAt: true },
        });
        return res.json({ ok: true, templates });
    }
    catch (err) {
        console.error(err);
        return res.status(500).json({ error: "Failed to fetch templates" });
    }
});
// POST /messages/templates
router.post("/templates", authJwt_1.authJwt, tenant_1.requireTenant, async (req, res) => {
    try {
        const { name, text, voice = "anna" } = req.body;
        if (!name || !text)
            return res.status(400).json({ error: "name and text are required" });
        const template = await client_1.prisma.messageTemplate.create({
            data: { name, text, voice,
                tenant: { connect: { id: tenantId(req) } },
                user: { connect: { id: userId(req) } },
            },
        });
        return res.status(201).json({ ok: true, template });
    }
    catch (err) {
        console.error(err);
        return res.status(500).json({ error: "Failed to save template" });
    }
});
// DELETE /messages/templates/:id
router.delete("/templates/:id", authJwt_1.authJwt, tenant_1.requireTenant, async (req, res) => {
    try {
        const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
        const template = await client_1.prisma.messageTemplate.findFirst({ where: { id, tenantId: tenantId(req), userId: userId(req) } });
        if (!template)
            return res.status(404).json({ error: "Template not found" });
        await client_1.prisma.messageTemplate.delete({ where: { id } });
        return res.json({ ok: true });
    }
    catch (err) {
        console.error(err);
        return res.status(500).json({ error: "Failed to delete template" });
    }
});
// POST /messages
router.post("/", authJwt_1.authJwt, tenant_1.requireTenant, async (req, res) => {
    try {
        const tid = tenantId(req);
        const uid = userId(req);
        const { text, voice = "anna", targetType, targetId, scheduledAt } = req.body;
        if (!text?.trim())
            return res.status(400).json({ error: "Text is required" });
        if (!targetType)
            return res.status(400).json({ error: "targetType is required" });
        const filename = await (0, tts_service_1.generateTTS)(text.trim(), voice);
        const fileUrl = `${process.env.BASE_URL ?? "https://api.schoollive.hu"}/audio/${filename}`;
        const scheduledTime = scheduledAt ? new Date(scheduledAt) : null;
        const isImmediate = !scheduledTime || scheduledTime <= new Date();
        const message = await client_1.prisma.message.create({
            data: {
                tenantId: tid, createdById: uid, type: "TTS",
                title: text.trim().substring(0, 64), text: text.trim(),
                voice, fileUrl, targetType, targetId: targetId ?? null, scheduledAt: scheduledTime,
            },
        });
        const allDeviceIds = await resolveDeviceIds(tid, targetType, targetId);
        if (allDeviceIds.length === 0)
            return res.status(201).json({ ok: true, message });
        if (isImmediate) {
            const onlineIds = allDeviceIds.filter(id => SyncEngine_1.SyncEngine.isDeviceOnline(id));
            const offlineIds = allDeviceIds.filter(id => !SyncEngine_1.SyncEngine.isDeviceOnline(id));
            if (onlineIds.length > 0) {
                SyncEngine_1.SyncEngine.dispatchSync({
                    tenantId: tid, commandId: `msg-${message.id}`,
                    action: "TTS", url: fileUrl,
                    text: text.trim(), title: text.trim().substring(0, 64),
                    targetDeviceIds: onlineIds,
                }).catch(e => console.error("[MESSAGES] SyncEngine hiba:", e));
                console.log(`[MESSAGES] 📤 SyncCast TTS → ${onlineIds.length} online | tenant: ${tid}`);
            }
            if (offlineIds.length > 0) {
                await client_1.prisma.deviceCommand.createMany({
                    data: offlineIds.map(deviceId => ({
                        tenantId: tid, deviceId, messageId: message.id, status: "QUEUED",
                        payload: { action: "TTS", url: fileUrl, text: text.trim(), title: text.trim().substring(0, 64), scheduledAt: null },
                    })),
                });
                console.log(`[MESSAGES] 📤 DB queue TTS → ${offlineIds.length} offline | tenant: ${tid}`);
            }
        }
        else {
            await client_1.prisma.deviceCommand.createMany({
                data: allDeviceIds.map(deviceId => ({
                    tenantId: tid, deviceId, messageId: message.id, status: "QUEUED",
                    payload: { action: "TTS", url: fileUrl, text: text.trim(), title: text.trim().substring(0, 64), scheduledAt: scheduledTime?.toISOString() ?? null },
                })),
            });
            console.log(`[MESSAGES] 📅 Ütemezett TTS → ${allDeviceIds.length} eszköz @ ${scheduledTime?.toISOString()} | tenant: ${tid}`);
        }
        return res.status(201).json({ ok: true, message });
    }
    catch (err) {
        console.error(err);
        return res.status(500).json({ error: "Failed to create message" });
    }
});
// GET /messages/:id
router.get("/:id", authJwt_1.authJwt, tenant_1.requireTenant, async (req, res) => {
    try {
        const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
        const message = await client_1.prisma.message.findFirst({
            where: { id, tenantId: tenantId(req) },
            include: {
                createdBy: { select: { id: true, displayName: true, email: true } },
                commands: { select: { id: true, deviceId: true, status: true, queuedAt: true, ackedAt: true } },
            },
        });
        if (!message)
            return res.status(404).json({ error: "Message not found" });
        return res.json({ ok: true, message });
    }
    catch (err) {
        console.error(err);
        return res.status(500).json({ error: "Failed to fetch message" });
    }
});
// DELETE /messages/:id
router.delete("/:id", authJwt_1.authJwt, tenant_1.requireTenant, async (req, res) => {
    try {
        const tid = tenantId(req);
        const user = req.user;
        const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
        if (user?.role !== "SUPER_ADMIN" && user?.role !== "TENANT_ADMIN")
            return res.status(403).json({ error: "Forbidden" });
        const message = await client_1.prisma.message.findFirst({ where: { id, tenantId: tid }, select: { id: true } });
        if (!message)
            return res.status(404).json({ error: "Message not found" });
        await client_1.prisma.deviceCommand.deleteMany({ where: { messageId: id } });
        await client_1.prisma.message.delete({ where: { id } });
        return res.json({ ok: true });
    }
    catch (err) {
        console.error(err);
        return res.status(500).json({ error: "Failed to delete message" });
    }
});
async function resolveDeviceIds(tid, targetType, targetId) {
    if (targetType === "ALL") {
        return (await client_1.prisma.device.findMany({ where: { tenantId: tid, online: true }, select: { id: true } })).map(d => d.id);
    }
    if (targetType === "DEVICE" && targetId)
        return [targetId];
    if (targetType === "GROUP" && targetId) {
        return (await client_1.prisma.deviceGroupMember.findMany({ where: { groupId: targetId }, select: { deviceId: true } })).map(m => m.deviceId);
    }
    if (targetType === "ORG_UNIT" && targetId) {
        return (await client_1.prisma.device.findMany({ where: { tenantId: tid, orgUnitId: targetId, online: true }, select: { id: true } })).map(d => d.id);
    }
    return [];
}
exports.default = router;

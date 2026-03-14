"use strict";
// src/modules/radio/radio.scheduler.ts
//
// Dispatch stratégia:
//   1. SyncEngine.dispatchSync() → online WebSocket VP eszközök (szinkron)
//   2. DeviceCommand DB queue    → offline / poll-alapú eszközök (fallback)
Object.defineProperty(exports, "__esModule", { value: true });
exports.startRadioScheduler = startRadioScheduler;
const client_1 = require("../../prisma/client");
const SyncEngine_1 = require("../../sync/SyncEngine");
const TICK_INTERVAL_MS = 30_000;
const LOOKAHEAD_MS = 60_000;
const DISPATCH_WINDOW_MS = 10_000;
let _running = false;
async function tick() {
    const now = new Date();
    const horizon = new Date(now.getTime() + LOOKAHEAD_MS);
    try {
        const due = await client_1.prisma.radioSchedule.findMany({
            where: {
                status: "PENDING",
                scheduledAt: { gte: new Date(now.getTime() - DISPATCH_WINDOW_MS), lte: horizon },
            },
            include: {
                radioFile: {
                    select: { id: true, fileUrl: true, durationSec: true, originalName: true },
                },
            },
        });
        if (due.length === 0)
            return;
        console.log(`[RADIO-SCHEDULER] ${due.length} schedule(s) due`);
        for (const schedule of due) {
            try {
                await dispatchSchedule(schedule);
            }
            catch (e) {
                console.error(`[RADIO-SCHEDULER] Failed to dispatch ${schedule.id}:`, e);
            }
        }
    }
    catch (e) {
        console.error("[RADIO-SCHEDULER] tick error:", e);
    }
}
async function dispatchSchedule(schedule) {
    const allDeviceIds = await resolveDeviceIds(schedule.tenantId, schedule.targetType, schedule.targetId);
    if (allDeviceIds.length === 0) {
        console.warn(`[RADIO-SCHEDULER] Nincs online eszköz: ${schedule.id} – DISPATCHED státusz beállítva`);
    }
    else {
        const commandId = `radio-${schedule.id}`;
        const onlineIds = allDeviceIds.filter(id => SyncEngine_1.SyncEngine.isDeviceOnline(id));
        const offlineIds = allDeviceIds.filter(id => !SyncEngine_1.SyncEngine.isDeviceOnline(id));
        const payload = {
            action: "PLAY_URL",
            url: schedule.radioFile.fileUrl,
            durationSec: schedule.radioFile.durationSec,
            radioFileId: schedule.radioFile.id,
            title: schedule.radioFile.originalName,
            scheduledAt: schedule.scheduledAt.toISOString(),
            source: "RADIO",
        };
        // ── 1. SyncEngine → online WebSocket eszközök ────────────────────────────
        if (onlineIds.length > 0) {
            await SyncEngine_1.SyncEngine.dispatchSync({
                tenantId: schedule.tenantId,
                commandId,
                action: "PLAY_URL",
                url: schedule.radioFile.fileUrl,
                title: schedule.radioFile.originalName,
                targetDeviceIds: onlineIds,
            });
            console.log(`[RADIO-SCHEDULER] 📻 SyncCast: "${schedule.radioFile.originalName}"` +
                ` → ${onlineIds.length} online | tenant: ${schedule.tenantId}`);
        }
        // ── 2. DB queue → offline eszközök ───────────────────────────────────────
        if (offlineIds.length > 0) {
            await client_1.prisma.deviceCommand.createMany({
                data: offlineIds.map(deviceId => ({
                    tenantId: schedule.tenantId,
                    deviceId,
                    messageId: null,
                    status: "QUEUED",
                    payload,
                })),
            });
            console.log(`[RADIO-SCHEDULER] 📻 DB queue: "${schedule.radioFile.originalName}"` +
                ` → ${offlineIds.length} offline | tenant: ${schedule.tenantId}`);
        }
    }
    // Ütemezés státusz frissítése
    await client_1.prisma.radioSchedule.update({
        where: { id: schedule.id },
        data: { status: "DISPATCHED", dispatchedAt: new Date() },
    });
}
async function resolveDeviceIds(tenantId, targetType, targetId) {
    if (targetType === "ALL") {
        return (await client_1.prisma.device.findMany({ where: { tenantId, online: true }, select: { id: true } })).map(d => d.id);
    }
    if (targetType === "DEVICE" && targetId)
        return [targetId];
    if (targetType === "GROUP" && targetId) {
        return (await client_1.prisma.deviceGroupMember.findMany({ where: { groupId: targetId }, select: { deviceId: true } })).map(m => m.deviceId);
    }
    if (targetType === "ORG_UNIT" && targetId) {
        return (await client_1.prisma.device.findMany({ where: { tenantId, orgUnitId: targetId, online: true }, select: { id: true } })).map(d => d.id);
    }
    return [];
}
function startRadioScheduler() {
    if (_running)
        return;
    _running = true;
    console.log("[RADIO-SCHEDULER] Started (tick every 30s, lookahead 60s)");
    tick();
    setInterval(tick, TICK_INTERVAL_MS);
}

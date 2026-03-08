// src/modules/radio/radio.scheduler.ts
//
// Percenként fut, megkeresi a soron következő rádiós lejátszásokat
// és DeviceCommand-okat hoz létre (QUEUED státuszban).
//
// Integrálás server.ts-ben:
//   import { startRadioScheduler } from "./modules/radio/radio.scheduler";
//   startRadioScheduler();

import { prisma } from "../../prisma/client";

const TICK_INTERVAL_MS = 30_000;   // 30 másodpercenként ellenőrzés
const LOOKAHEAD_MS     = 60_000;   // 60 másodpercre előre néz
const DISPATCH_WINDOW_MS = 10_000; // 10 másodpercen belüli indítást küld el azonnal

let _running = false;

async function tick() {
  const now     = new Date();
  const horizon = new Date(now.getTime() + LOOKAHEAD_MS);

  try {
    // PENDING ütemezések amelyek a következő LOOKAHEAD_MS-en belül indulnak
    const due = await prisma.radioSchedule.findMany({
      where: {
        status:      "PENDING",
        scheduledAt: { gte: new Date(now.getTime() - DISPATCH_WINDOW_MS), lte: horizon },
      },
      include: {
        radioFile: {
          select: { id: true, fileUrl: true, durationSec: true, originalName: true },
        },
      },
    });

    if (due.length === 0) return;

    console.log(`[RADIO-SCHEDULER] ${due.length} schedule(s) due`);

    for (const schedule of due) {
      try {
        await dispatchSchedule(schedule);
      } catch (e) {
        console.error(`[RADIO-SCHEDULER] Failed to dispatch schedule ${schedule.id}:`, e);
      }
    }
  } catch (e) {
    console.error("[RADIO-SCHEDULER] tick error:", e);
  }
}

async function dispatchSchedule(schedule: {
  id:         string;
  tenantId:   string;
  targetType: string;
  targetId:   string | null;
  scheduledAt: Date;
  radioFile:  { id: string; fileUrl: string; durationSec: number | null; originalName: string };
}) {
  // Eszköz ID-k feloldása
  const deviceIds = await resolveDeviceIds(
    schedule.tenantId,
    schedule.targetType,
    schedule.targetId
  );

  if (deviceIds.length === 0) {
    console.warn(`[RADIO-SCHEDULER] No online devices for schedule ${schedule.id}, marking DISPATCHED anyway`);
  } else {
    // DeviceCommand-ok létrehozása
    await prisma.deviceCommand.createMany({
      data: deviceIds.map((deviceId) => ({
        tenantId:  schedule.tenantId,
        deviceId,
        messageId: null,
        status:    "QUEUED" as const,
        payload: {
          action:      "PLAY_URL",
          url:         schedule.radioFile.fileUrl,
          durationSec: schedule.radioFile.durationSec,
          radioFileId: schedule.radioFile.id,
          title:       schedule.radioFile.originalName,
          scheduledAt: schedule.scheduledAt.toISOString(),
          source:      "RADIO",
        },
      })),
    });

    console.log(
      `[RADIO-SCHEDULER] Dispatched schedule ${schedule.id} → ${deviceIds.length} device(s)` +
      ` | file: "${schedule.radioFile.originalName}"` +
      ` | scheduledAt: ${schedule.scheduledAt.toISOString()}`
    );
  }

  // Ütemezés státusz frissítése
  await prisma.radioSchedule.update({
    where: { id: schedule.id },
    data:  { status: "DISPATCHED", dispatchedAt: new Date() },
  });
}

async function resolveDeviceIds(
  tenantId: string,
  targetType: string,
  targetId: string | null
): Promise<string[]> {
  if (targetType === "ALL") {
    const devs = await prisma.device.findMany({
      where:  { tenantId, online: true },
      select: { id: true },
    });
    return devs.map((d) => d.id);
  }
  if (targetType === "DEVICE" && targetId) return [targetId];
  if (targetType === "GROUP" && targetId) {
    const members = await prisma.deviceGroupMember.findMany({
      where:  { groupId: targetId },
      select: { deviceId: true },
    });
    return members.map((m) => m.deviceId);
  }
  if (targetType === "ORG_UNIT" && targetId) {
    const devs = await prisma.device.findMany({
      where:  { tenantId, orgUnitId: targetId, online: true },
      select: { id: true },
    });
    return devs.map((d) => d.id);
  }
  return [];
}

export function startRadioScheduler() {
  if (_running) return;
  _running = true;
  console.log("[RADIO-SCHEDULER] Started (tick every 30s, lookahead 60s)");
  // Azonnal futtatjuk egyszer induláskor
  tick();
  setInterval(tick, TICK_INTERVAL_MS);
}
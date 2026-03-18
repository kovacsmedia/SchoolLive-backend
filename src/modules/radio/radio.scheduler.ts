// src/modules/radio/radio.scheduler.ts
//
// Dispatch stratégia:
//   1. SyncEngine.dispatchSync() → online WebSocket VP eszközök (szinkron)
//   2. DeviceCommand DB queue    → offline / poll-alapú eszközök (fallback)

import { prisma }     from "../../prisma/client";
import { SyncEngine } from "../../sync/SyncEngine";

const TICK_INTERVAL_MS   = 30_000;
const LOOKAHEAD_MS       = 60_000;
const DISPATCH_WINDOW_MS = 10_000;

let _running = false;

async function tick() {
  const now     = new Date();
  const horizon = new Date(now.getTime() + LOOKAHEAD_MS);

  try {
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
        console.error(`[RADIO-SCHEDULER] Failed to dispatch ${schedule.id}:`, e);
      }
    }
  } catch (e) {
    console.error("[RADIO-SCHEDULER] tick error:", e);
  }
}

async function dispatchSchedule(schedule: {
  id:          string;
  tenantId:    string;
  targetType:  string;
  targetId:    string | null;
  scheduledAt: Date;
  radioFile:   { id: string; fileUrl: string; durationSec: number | null; originalName: string };
}) {
  const allDeviceIds = await resolveDeviceIds(
    schedule.tenantId,
    schedule.targetType,
    schedule.targetId,
  );

  if (allDeviceIds.length === 0) {
    console.warn(`[RADIO-SCHEDULER] Nincs online eszköz: ${schedule.id} – DISPATCHED státusz beállítva`);
  } else {
    const commandId  = `radio-${schedule.id}`;
    const onlineIds  = allDeviceIds.filter(id => SyncEngine.isDeviceOnline(id));
    const offlineIds = allDeviceIds.filter(id => !SyncEngine.isDeviceOnline(id));

    const payload = {
      action:      "PLAY_URL",
      url:         schedule.radioFile.fileUrl,
      durationSec: schedule.radioFile.durationSec,
      radioFileId: schedule.radioFile.id,
      title:       schedule.radioFile.originalName,
      scheduledAt: schedule.scheduledAt.toISOString(),
      source:      "RADIO",
    };

    // ── 1. SyncEngine → online WebSocket eszközök ────────────────────────────
    if (onlineIds.length > 0) {
      await SyncEngine.dispatchSync({
        tenantId:        schedule.tenantId,
        commandId,
        action:          "PLAY_URL",
        url:             schedule.radioFile.fileUrl,
        title:           schedule.radioFile.originalName,
        targetDeviceIds: onlineIds,
      });
      console.log(
        `[RADIO-SCHEDULER] 📻 SyncCast: "${schedule.radioFile.originalName}"` +
        ` → ${onlineIds.length} online | tenant: ${schedule.tenantId}`,
      );
    }

    // ── 2. DB queue → offline eszközök ───────────────────────────────────────
    if (offlineIds.length > 0) {
      await prisma.deviceCommand.createMany({
        data: offlineIds.map(deviceId => ({
          tenantId:  schedule.tenantId,
          deviceId,
          messageId: null,
          status:    "QUEUED" as const,
          payload,
        })),
      });
      console.log(
        `[RADIO-SCHEDULER] 📻 DB queue: "${schedule.radioFile.originalName}"` +
        ` → ${offlineIds.length} offline | tenant: ${schedule.tenantId}`,
      );
    }
  }

  // Ütemezés státusz frissítése
  await prisma.radioSchedule.update({
    where: { id: schedule.id },
    data:  { status: "DISPATCHED", dispatchedAt: new Date() },
  });
}

async function resolveDeviceIds(
  tenantId:   string,
  targetType: string,
  targetId:   string | null,
): Promise<string[]> {
  if (targetType === "ALL") {
    return (await prisma.device.findMany({ where: { tenantId, online: true }, select: { id: true } })).map(d => d.id);
  }
  if (targetType === "DEVICE" && targetId) return [targetId];
  if (targetType === "GROUP" && targetId) {
    return (await prisma.deviceGroupMember.findMany({ where: { groupId: targetId }, select: { deviceId: true } })).map(m => m.deviceId);
  }
  if (targetType === "ORG_UNIT" && targetId) {
    return (await prisma.device.findMany({ where: { tenantId, orgUnitId: targetId, online: true }, select: { id: true } })).map(d => d.id);
  }
  return [];
}

// ── yt-dlp napi frissítés ─────────────────────────────────────────────────
async function updateYtDlp() {
  const { spawn } = await import("child_process");
  const { existsSync } = await import("fs");

  const candidates = [
    "/home/balazs/.local/bin/yt-dlp",
    "/usr/local/bin/yt-dlp",
    "/usr/bin/yt-dlp",
  ];
  const bin = candidates.find(p => existsSync(p)) ?? "yt-dlp";

  console.log(`[YT-UPDATE] yt-dlp frissítés indítása: ${bin}`);
  return new Promise<void>((resolve) => {
    const proc = spawn(bin, ["--update"], { stdio: "pipe" });
    let out = "";
    proc.stdout?.on("data", (d: Buffer) => { out += d.toString(); });
    proc.stderr?.on("data", (d: Buffer) => { out += d.toString(); });
    proc.on("close", (code: number) => {
      console.log(`[YT-UPDATE] Kész (code=${code}): ${out.trim().split("\n").pop() ?? ""}`);
      resolve();
    });
    proc.on("error", (e: Error) => {
      console.warn("[YT-UPDATE] Hiba:", e.message);
      resolve();
    });
  });
}

function scheduleYtDlpUpdate() {
  // Éjjel 3:00-kor frissít naponta
  function msUntilNextUpdate(): number {
    const now  = new Date();
    const next = new Date(now);
    next.setHours(3, 0, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    return next.getTime() - now.getTime();
  }
  setTimeout(function run() {
    void updateYtDlp();
    setTimeout(run, 24 * 60 * 60 * 1000);  // következő nap
  }, msUntilNextUpdate());
  console.log(`[YT-UPDATE] Következő frissítés: ${Math.round(msUntilNextUpdate()/1000/60)} perc múlva`);
}

export function startRadioScheduler() {
  if (_running) return;
  _running = true;
  console.log("[RADIO-SCHEDULER] Started (tick every 30s, lookahead 60s)");
  tick();
  setInterval(tick, TICK_INTERVAL_MS);
  scheduleYtDlpUpdate();
}
// src/modules/bells/bells.scheduler.ts
//
// Dispatch stratégia (Snapcast alapú):
//   1. SnapcastService → PCM stream a FIFO-n át, minden csatlakozott kliens hallja
//   2. SyncEngine broadcast → vezérlőcsatorna (snapcastActive flag, overlay VP-re)
//   3. DeviceCommand DB queue → offline eszközök fallback

import { prisma }          from "../../prisma/client";
import { SyncEngine }      from "../../sync/SyncEngine";
import { SnapcastService } from "../snapcast/snapcast.service";
import path                from "path";
import { randomUUID }      from "crypto";

function todayInBudapest(): Date {
  const now = new Date();
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Budapest",
    year: "numeric", month: "2-digit", day: "2-digit",
  });
  const [year, month, day] = fmt.format(now).split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

const TICK_INTERVAL_MS  = 60_000;
const DISPATCH_WINDOW_S = 30;

let _running = false;
const _dispatched = new Set<string>();

async function tick() {
  const now           = new Date();
  const todayMidnight = todayInBudapest();

  const budapestTime = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Budapest",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).format(now).split(":").map(Number);

  const hour   = budapestTime[0];
  const minute = budapestTime[1];
  const sec    = budapestTime[2];

  if (sec > DISPATCH_WINDOW_S) return;

  try {
    const tenants = await prisma.tenant.findMany({ select: { id: true } });
    for (const tenant of tenants) {
      await processTenant(tenant.id, todayMidnight, hour, minute, now);
    }
  } catch (e) {
    console.error("[BELLS-SCHEDULER] tick error:", e);
  }
}

async function processTenant(
  tenantId:      string,
  todayMidnight: Date,
  hour:          number,
  minute:        number,
  now:           Date,
) {
  // Minden eszköz – Snapcast az összes eszközre játszik (KEY=ESP32, JWT=VP)
  const allDevices = await prisma.device.findMany({
    where:  { tenantId },
    select: { id: true, authType: true },
  });
  if (allDevices.length === 0) return;

  const calDay = await (prisma as any).bellCalendarDay.findUnique({
    where:   { tenantId_date: { tenantId, date: todayMidnight } },
    include: { template: { include: { bells: { orderBy: [{ hour: "asc" }, { minute: "asc" }] } } } },
  }).catch(() => null);

  if (calDay?.isHoliday) return;

  let bells: Array<{ hour: number; minute: number; type: string; soundFile: string }> = [];
  if (calDay?.template?.bells?.length) {
    bells = calDay.template.bells;
  } else {
    const def = await (prisma as any).bellScheduleTemplate.findFirst({
      where:   { tenantId, isDefault: true },
      include: { bells: { orderBy: [{ hour: "asc" }, { minute: "asc" }] } },
    }).catch(() => null);
    bells = def?.bells ?? [];
  }
  if (bells.length === 0) return;

  const dueBells = bells.filter(b => b.hour === hour && b.minute === minute);
  if (dueBells.length === 0) return;

  for (const bell of dueBells) {
    const dispatchKey = `${tenantId}:${now.toISOString().slice(0, 16)}:${bell.hour}:${bell.minute}:${bell.type}`;
    if (_dispatched.has(dispatchKey)) continue;
    _dispatched.add(dispatchKey);

    if (_dispatched.size > 1000) {
      const arr = Array.from(_dispatched);
      arr.slice(0, 500).forEach(k => _dispatched.delete(k));
    }

    const commandId = randomUUID();
    const audioUrl  = `https://api.schoollive.hu/audio/bells/${bell.soundFile}`;
    const soundPath = path.join(process.cwd(), "audio", "bells", bell.soundFile);

    // ── 1. Snapcast: elsődleges lejátszás (online mód) ──────────────────────
    const snapOnline = await SnapcastService.isSnapserverOnline();
    if (snapOnline) {
      SnapcastService.play({
        type:     "BELL",
        source:   { type: "file", path: soundPath },
        tenantId,
        title:    `Csengetés ${String(bell.hour).padStart(2,"0")}:${String(bell.minute).padStart(2,"0")}`,
      });
      console.log(
        `[BELLS-SCHEDULER] 🔔 Snapcast: ${bell.hour}:${String(bell.minute).padStart(2,"0")}` +
        ` (${bell.type}) | tenant: ${tenantId}`,
      );
    } else {
      console.warn(`[BELLS-SCHEDULER] ⚠️ Snapserver offline – csak fallback | tenant: ${tenantId}`);
    }

    // ── 2. SyncEngine broadcast – vezérlőcsatorna ───────────────────────────
    // snapcastActive=true → ESP32 NE játsszon lokálisan (Snapcast kezeli)
    // snapcastActive=false → ESP32 játsszon lokálisan (offline fallback)
    // VP eszközök megkapják a szöveget overlay megjelenítéshez
    SyncEngine.broadcastImmediate(tenantId, {
      action:         "BELL",
      commandId,
      url:            audioUrl,
      type:           bell.type,
      soundFile:      bell.soundFile,
      hour:           bell.hour,
      minute:         bell.minute,
      snapcastActive: snapOnline,  // ESP32 eldönti: Snapcast vagy lokális lejátszás
    });

    // ── 3. DB queue – offline eszközök fallback ──────────────────────────────
    // Csak VP eszközök (JWT) kerülnek a DB queue-ba – ESP32 saját offline logikája van
    const offlineVpIds = allDevices
      .filter(d => d.authType === "JWT" && !SyncEngine.isDeviceOnline(d.id))
      .map(d => d.id);

    if (offlineVpIds.length > 0) {
      await prisma.deviceCommand.createMany({
        data: offlineVpIds.map(deviceId => ({
          tenantId,
          deviceId,
          messageId: null,
          status:    "QUEUED" as const,
          payload: {
            action:    "BELL",
            url:       audioUrl,
            type:      bell.type,
            soundFile: bell.soundFile,
            hour:      bell.hour,
            minute:    bell.minute,
          },
        })),
      });
      console.log(
        `[BELLS-SCHEDULER] 🔔 DB queue: ${bell.hour}:${String(bell.minute).padStart(2,"0")}` +
        ` → ${offlineVpIds.length} offline VP | tenant: ${tenantId}`,
      );
    }
  }
}

export function startBellsScheduler() {
  if (_running) return;
  _running = true;
  console.log("[BELLS-SCHEDULER] Started (tick every 60s, ±30s window)");
  tick();
  setInterval(tick, TICK_INTERVAL_MS);
}
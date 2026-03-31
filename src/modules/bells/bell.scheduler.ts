// src/modules/bells/bells.scheduler.ts
//
// Javítások:
//   • setTimeout alapú pontos indítás – pontosan :00 másodperckor szól a csengő
//   • durationMs kiszámítása ffprobe-bal, átadva SyncEngine-nek
//   • PREPARE/PLAY sync a csengetésekhez (nem broadcastImmediate)

import { prisma }          from "../../prisma/client";
import { SyncEngine }      from "../../sync/SyncEngine";
import { SnapcastService } from "../snapcast/snapcast.service";
import { execSync }        from "child_process";
import path                from "path";
import { randomUUID }      from "crypto";

const TICK_INTERVAL_MS  = 30_000;   // 30s tick – elég sűrű az előrenézéshez
const LOOKAHEAD_MS      = 90_000;   // 90s előre néz
const PREPARE_LEAD_MS   = 4_000;    // 4s PREPARE az eszközöknek

let _running = false;
const _dispatched = new Set<string>();
const _pendingTimeouts = new Map<string, ReturnType<typeof setTimeout>[]>();

// ── Hangfájl hosszának lekérése ffprobe-bal ──────────────────────────────────
function getAudioDurationMs(filePath: string): number | null {
  try {
    const out = execSync(
      `ffprobe -v quiet -show_entries format=duration -of csv=p=0 "${filePath}"`,
      { timeout: 3000 }
    ).toString().trim();
    const sec = parseFloat(out);
    if (isFinite(sec) && sec > 0) return Math.round(sec * 1000);
  } catch {}
  return null;
}

function todayInBudapest(): Date {
  const now = new Date();
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Budapest",
    year: "numeric", month: "2-digit", day: "2-digit",
  });
  const [year, month, day] = fmt.format(now).split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

// ── Tick – előrenéz és ütemezi a csengetéseket setTimeout-tal ───────────────
async function tick() {
  const now     = new Date();
  const horizon = new Date(now.getTime() + LOOKAHEAD_MS);

  try {
    const tenants = await prisma.tenant.findMany({ select: { id: true } });
    for (const tenant of tenants) {
      await scheduleTenantBells(tenant.id, now, horizon);
    }
  } catch (e) {
    console.error("[BELLS-SCHEDULER] tick error:", e);
  }
}

async function scheduleTenantBells(tenantId: string, now: Date, horizon: Date) {
  const todayMidnight = todayInBudapest();

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

  // Lookahead ablakba eső csengetések
  for (const bell of bells) {
    // Csengetés UTC időpontjának kiszámítása (Europe/Budapest)
    const bellMs = getBellMs(bell.hour, bell.minute);
    if (bellMs < now.getTime() || bellMs > horizon.getTime()) continue;

    const dispatchKey = `${tenantId}:${bell.hour}:${bell.minute}:${bell.type}:${todayMidnight.toISOString().slice(0,10)}`;
    if (_dispatched.has(dispatchKey)) continue;
    if (_pendingTimeouts.has(dispatchKey)) continue; // már be van ütemezve

    _dispatched.add(dispatchKey);
    if (_dispatched.size > 1000) {
      const arr = Array.from(_dispatched);
      arr.slice(0, 500).forEach(k => _dispatched.delete(k));
    }

    const waitMs        = bellMs - now.getTime();
    const prepareDelay  = Math.max(0, waitMs - PREPARE_LEAD_MS);
    const snapDelay     = Math.max(0, waitMs);
    const commandId     = randomUUID();
    const audioUrl      = `https://api.schoollive.hu/audio/bells/${bell.soundFile}`;
    const soundPath     = path.join(process.cwd(), "audio", "bells", bell.soundFile);
    const durationMs    = getAudioDurationMs(soundPath);

    console.log(`[BELLS-SCHEDULER] Ütemezve: ${bell.hour}:${String(bell.minute).padStart(2,"0")} | wait=${Math.round(waitMs/1000)}s | dur=${durationMs}ms`);

    const timeouts: ReturnType<typeof setTimeout>[] = [];

    // ── PREPARE küldése PREPARE_LEAD_MS-sel korábban ─────────────────────────
    const prepareTimeout = setTimeout(async () => {
      const allDevices = await prisma.device.findMany({
        where:  { tenantId },
        select: { id: true, authType: true },
      });
      if (allDevices.length === 0) return;

      const snapOnline = await SnapcastService.isSnapserverOnline(tenantId);
      const onlineIds  = allDevices.map(d => d.id).filter(id => SyncEngine.isDeviceOnline(id));
      const offlineIds = allDevices.map(d => d.id).filter(id => !SyncEngine.isDeviceOnline(id));

      if (onlineIds.length > 0) {
        await SyncEngine.dispatchSync({
          tenantId,
          commandId,
          action:          "BELL",
          url:             audioUrl,
          title:           `Csengetés ${String(bell.hour).padStart(2,"0")}:${String(bell.minute).padStart(2,"0")}`,
          targetDeviceIds: onlineIds,
          snapcastActive:  snapOnline,
          playAtMs:        bellMs,
          durationMs:      durationMs ?? undefined,
        });
      }

      // DB queue offline eszközöknek
      if (offlineIds.length > 0) {
        await prisma.deviceCommand.createMany({
          data: offlineIds.map(deviceId => ({
            tenantId, deviceId, messageId: null,
            status: "QUEUED" as const,
            payload: { action: "BELL", url: audioUrl, type: bell.type, soundFile: bell.soundFile, hour: bell.hour, minute: bell.minute },
          })),
        });
      }
    }, prepareDelay);
    timeouts.push(prepareTimeout);

    // ── Snapcast indítása pontosan a csengetés pillanatában ────────────────────
    const snapTimeout = setTimeout(async () => {
      const snapOnline = await SnapcastService.isSnapserverOnline(tenantId);
      if (snapOnline) {
        await SnapcastService.play({
          type:     "BELL",
          source:   { type: "file", path: soundPath },
          tenantId,
          title:    `Csengetés ${String(bell.hour).padStart(2,"0")}:${String(bell.minute).padStart(2,"0")}`,
        });
        console.log(`[BELLS-SCHEDULER] 🔔 Snapcast PLAY: ${bell.hour}:${String(bell.minute).padStart(2,"0")} | tenant: ${tenantId}`);
      }
      _pendingTimeouts.delete(dispatchKey);
    }, snapDelay);
    timeouts.push(snapTimeout);

    _pendingTimeouts.set(dispatchKey, timeouts);
  }
}

// ── Adott óra:perc UTC ms-e (Europe/Budapest alapján) ────────────────────────
function getBellMs(hour: number, minute: number): number {
  const now = new Date();
  // Budapest offset kiszámítása
  const budapestStr = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Budapest",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).format(now);
  const [y, m, d] = budapestStr.split("-").map(Number);

  // Budapest időzóna offset meghatározása
  const localMidnight = new Date(`${y}-${String(m).padStart(2,"0")}-${String(d).padStart(2,"0")}T00:00:00`);
  const budapestMidnight = new Date(localMidnight.toLocaleString("en-US", { timeZone: "Europe/Budapest" }));
  const offsetMs = localMidnight.getTime() - budapestMidnight.getTime() + localMidnight.getTimezoneOffset() * 60000;

  // A csengetés UTC időpontja
  const bellUtc = new Date(Date.UTC(y, m - 1, d, hour, minute, 0, 0));
  return bellUtc.getTime() - offsetMs;
}

// ── Stop (rádió stop hívja) ───────────────────────────────────────────────────
export function cancelPendingBells() {
  for (const [key, timeouts] of _pendingTimeouts.entries()) {
    timeouts.forEach(t => clearTimeout(t));
    _pendingTimeouts.delete(key);
  }
}

export function startBellsScheduler() {
  if (_running) return;
  _running = true;
  console.log("[BELLS-SCHEDULER] Started (tick every 30s, lookahead 90s)");
  tick();
  setInterval(tick, TICK_INTERVAL_MS);
}
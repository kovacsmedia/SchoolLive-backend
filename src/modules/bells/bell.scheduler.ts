// src/modules/bells/bells.scheduler.ts
//
// v3 változások:
//   • broadcastSyncBells(tenantId): azonnali SYNC_BELLS push minden online kliensnek
//     → bell template/schedule módosításkor azonnal értesíti a klienseket
//   • MIN_FUTURE_MS guard megmarad (restart védelem)
//   • getBellMs() timezone fix megmarad

import { prisma }          from "../../prisma/client";
import { SyncEngine }      from "../../sync/SyncEngine";
import { SnapcastService } from "../snapcast/snapcast.service";
import { execSync }        from "child_process";
import path                from "path";
import { randomUUID }      from "crypto";

const TICK_INTERVAL_MS = 30_000;
const LOOKAHEAD_MS     = 90_000;
const PREPARE_LEAD_MS  = 4_000;
const MIN_FUTURE_MS    = 1_000;

let _running = false;
const _dispatched      = new Set<string>();
const _pendingTimeouts = new Map<string, ReturnType<typeof setTimeout>[]>();

// ── Hangfájl hossza ───────────────────────────────────────────────────────────
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

function getBellMs(hour: number, minute: number): number {
  const now = new Date();
  const budapestDateStr = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Budapest",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).format(now);
  const [y, m, d] = budapestDateStr.split("-").map(Number);
  const bellLocalStr = `${y}-${String(m).padStart(2,"0")}-${String(d).padStart(2,"0")}T${String(hour).padStart(2,"0")}:${String(minute).padStart(2,"0")}:00`;
  const tempDate   = new Date(`${bellLocalStr}Z`);
  const budapestMs = new Date(tempDate.toLocaleString("en-US", { timeZone: "Europe/Budapest" })).getTime();
  const offsetMs   = tempDate.getTime() - budapestMs;
  return new Date(`${bellLocalStr}Z`).getTime() + offsetMs;
}

// ── SYNC_BELLS push – azonnali értesítés ──────────────────────────────────────
//
// Bell template vagy naptár módosításakor hívja a controller.
// Minden online kliens azonnal frissíti a bell listáját.
//
export function broadcastSyncBells(tenantId: string): void {
  console.log(`[BELLS-SCHEDULER] 📡 SYNC_BELLS broadcast → tenant=${tenantId}`);
  SyncEngine.broadcastImmediate(tenantId, { action: "SYNC_BELLS" });
}

// ── Tick ──────────────────────────────────────────────────────────────────────
async function tick() {
  const now       = new Date();
  const horizon   = new Date(now.getTime() + LOOKAHEAD_MS);
  const todayPrefix = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Budapest",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).format(now);

  for (const key of _dispatched) {
    if (!key.includes(todayPrefix)) _dispatched.delete(key);
  }

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

  const budapestDayOfWeek = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Budapest", weekday: "short",
  }).format(now);
  const isWeekend         = budapestDayOfWeek === "Sat" || budapestDayOfWeek === "Sun";
  const hasExplicitTemplate = !!calDay?.template?.bells?.length;
  if (isWeekend && !hasExplicitTemplate) return;

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

  const todayStr = todayMidnight.toISOString().slice(0, 10);

  for (const bell of bells) {
    const bellMs = getBellMs(bell.hour, bell.minute);
    const waitMs = bellMs - now.getTime();

    if (waitMs < MIN_FUTURE_MS) continue;
    if (bellMs > horizon.getTime()) continue;

    const dispatchKey = `${tenantId}:${todayStr}:${String(bell.hour).padStart(2,"0")}:${String(bell.minute).padStart(2,"0")}:${bell.type}`;
    if (_dispatched.has(dispatchKey)) continue;
    if (_pendingTimeouts.has(dispatchKey)) continue;

    _dispatched.add(dispatchKey);

    const prepareDelay = Math.max(0, waitMs - PREPARE_LEAD_MS);
    const snapDelay    = Math.max(0, waitMs);
    const commandId    = randomUUID();
    const audioUrl     = `https://api.schoollive.hu/audio/bells/${bell.soundFile}`;
    const soundPath    = path.join(process.cwd(), "audio", "bells", bell.soundFile);
    const durationMs   = getAudioDurationMs(soundPath);
    const bellTimeStr  = `${String(bell.hour).padStart(2,"0")}:${String(bell.minute).padStart(2,"0")}`;

    console.log(`[BELLS-SCHEDULER] Ütemezve: ${bellTimeStr} | wait=${Math.round(waitMs/1000)}s | dur=${durationMs}ms`);

    const timeouts: ReturnType<typeof setTimeout>[] = [];

    const prepareTimeout = setTimeout(async () => {
      try {
        const allDevices = await prisma.device.findMany({
          where: { tenantId }, select: { id: true },
        });
        if (allDevices.length === 0) return;

        const snapOnline = await SnapcastService.isSnapserverOnline(tenantId);
        const onlineIds  = allDevices.map(d => d.id).filter(id => SyncEngine.isDeviceOnline(id));
        const offlineIds = allDevices.map(d => d.id).filter(id => !SyncEngine.isDeviceOnline(id));

        if (onlineIds.length > 0) {
          await SyncEngine.dispatchSync({
            tenantId, commandId, action: "BELL",
            url:            audioUrl,
            title:          `Csengetés ${bellTimeStr}`,
            targetDeviceIds: onlineIds,
            snapcastActive:  snapOnline,
            playAtMs:        bellMs,
            durationMs:      durationMs ?? undefined,
          });
          console.log(`[BELLS-SCHEDULER] PREPARE → ${onlineIds.length} eszköz | snap=${snapOnline}`);
        }
        if (offlineIds.length > 0) {
          await prisma.deviceCommand.createMany({
            data: offlineIds.map(deviceId => ({
              tenantId, deviceId, messageId: null, status: "QUEUED" as const,
              payload: { action: "BELL", url: audioUrl, type: bell.type,
                         soundFile: bell.soundFile, hour: bell.hour, minute: bell.minute },
            })),
          });
        }
      } catch (e) {
        console.error(`[BELLS-SCHEDULER] PREPARE hiba (${bellTimeStr}):`, e);
      }
    }, prepareDelay);
    timeouts.push(prepareTimeout);

    const snapTimeout = setTimeout(async () => {
      try {
        const snapOnline = await SnapcastService.isSnapserverOnline(tenantId);
        if (snapOnline) {
          await SnapcastService.play({
            type: "BELL", source: { type: "file", path: soundPath },
            tenantId, title: `Csengetés ${bellTimeStr}`,
          });
          console.log(`[BELLS-SCHEDULER] 🔔 Snap PLAY: ${bellTimeStr}`);
        }
      } catch (e) {
        console.error(`[BELLS-SCHEDULER] Snap hiba (${bellTimeStr}):`, e);
      } finally {
        _pendingTimeouts.delete(dispatchKey);
      }
    }, snapDelay);
    timeouts.push(snapTimeout);

    _pendingTimeouts.set(dispatchKey, timeouts);
  }
}

export function cancelPendingBells() {
  for (const [key, timeouts] of _pendingTimeouts.entries()) {
    timeouts.forEach(t => clearTimeout(t));
    _pendingTimeouts.delete(key);
  }
}

export function startBellsScheduler() {
  if (_running) return;
  _running = true;
  console.log("[BELLS-SCHEDULER] Indult (tick: 30s, lookahead: 90s, min_future: 1s)");
  tick();
  setInterval(tick, TICK_INTERVAL_MS);
}
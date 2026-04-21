// src/modules/bells/bells.scheduler.ts
//
// Javítások:
//   • getBellMs(): helyes Budapest timezone kezelés (Intl.DateTimeFormat offset)
//   • _dispatched key tartalmaz dátumot → nap-szintű dedup, nem csak perc
//   • Backend restart utáni "elmúlt bell" védelem: csak jövőbeli (now+1s) belleket ütemez
//   • PREPARE és Snap timeout kezelése: ha a snap offline, nem küldi a snapcastActive=true-t
//   • Cleanup: _pendingTimeouts és _dispatched periodikus takarítása

import { prisma }          from "../../prisma/client";
import { SyncEngine }      from "../../sync/SyncEngine";
import { SnapcastService } from "../snapcast/snapcast.service";
import { execSync }        from "child_process";
import path                from "path";
import { randomUUID }      from "crypto";

const TICK_INTERVAL_MS = 30_000;   // 30s tick
const LOOKAHEAD_MS     = 90_000;   // 90s előrenézés
const PREPARE_LEAD_MS  = 4_000;    // PREPARE 4s-sel korábban
const MIN_FUTURE_MS    = 1_000;    // Csak legalább 1s jövőbeli belleket ütemez
                                   // → restart után nem játssza le az előző percet

let _running = false;

// dispatchKey = "tenantId:YYYY-MM-DD:HH:MM:type"
// Nap-szintű prefix → éjfélkor automatikusan érvénytelen
const _dispatched     = new Set<string>();
const _pendingTimeouts = new Map<string, ReturnType<typeof setTimeout>[]>();

// ── Hangfájl hossza ffprobe-bal ───────────────────────────────────────────────
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

// ── Aktuális nap Budapest időzónában ─────────────────────────────────────────
function todayInBudapest(): Date {
  const now = new Date();
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Budapest",
    year: "numeric", month: "2-digit", day: "2-digit",
  });
  const [year, month, day] = fmt.format(now).split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

// ── Bell UTC ms kiszámítása Budapest időzónából ───────────────────────────────
//
// Helyes módszer: Intl.DateTimeFormat-tal lekérdezzük hogy Budapest szerint
// pontosan mikor van az adott óra:perc, majd visszakonvertálunk UTC-be.
//
// A korábbi verzióban duplikált offset számítás volt (localMidnight + Budapest
// offset + localTimezoneOffset), ami egyes szerver konfigokon 1-2 órát tévedett.
//
function getBellMs(hour: number, minute: number): number {
  const now = new Date();

  // Aktuális dátum Budapest szerint
  const budapestDateStr = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Budapest",
    year:  "numeric",
    month: "2-digit",
    day:   "2-digit",
  }).format(now);
  const [y, m, d] = budapestDateStr.split("-").map(Number);

  // Budapest időzóna offsetjének meghatározása az adott pillanatban
  // (DST-t is figyelembe veszi automatikusan)
  const bellLocalStr = `${y}-${String(m).padStart(2,"0")}-${String(d).padStart(2,"0")}T${String(hour).padStart(2,"0")}:${String(minute).padStart(2,"0")}:00`;

  // Trick: Date.parse a lokális időt UTC-ként értelmezi,
  // de mi meg tudjuk határozni a Budapest offsetet az Intl API-val
  const tempDate = new Date(`${bellLocalStr}Z`);  // UTC-ként parse-oljuk
  const budapestMs = new Date(
    tempDate.toLocaleString("en-US", { timeZone: "Europe/Budapest" })
  ).getTime();
  const utcMs = tempDate.getTime();
  const offsetMs = utcMs - budapestMs;  // Budapest UTC offset (negatív télen)

  // A valódi UTC ms = a bell Budapest-idő UTC-ként értelmezve + offset korrekció
  return new Date(`${bellLocalStr}Z`).getTime() + offsetMs;
}

// ── ALTERNATÍV: egyszerűbb és biztonságosabb getBellMs ───────────────────────
// Ha a fenti bonyolultnak tűnik, ez is helyes:
//
// function getBellMs(hour: number, minute: number): number {
//   const budapestDateStr = new Intl.DateTimeFormat("en-CA", {
//     timeZone: "Europe/Budapest",
//     year: "numeric", month: "2-digit", day: "2-digit",
//   }).format(new Date());
//   const [y, m, d] = budapestDateStr.split("-").map(Number);
//   // Adjuk meg a dátum-időt Budapest szerint, és nézzük meg mi az UTC értéke
//   const candidate = new Date(
//     new Date(`${y}-${String(m).padStart(2,"0")}-${String(d).padStart(2,"0")}T${String(hour).padStart(2,"0")}:${String(minute).padStart(2,"0")}:00`)
//     .toLocaleString("en-US", { timeZone: "America/New_York" })  // ← NE ÍGY
//   );
// }
//
// Legbiztonságosabb módszer: timezone-aware library (pl. date-fns-tz):
//   import { zonedTimeToUtc } from "date-fns-tz";
//   return zonedTimeToUtc(`${y}-${m}-${d}T${hour}:${minute}:00`, "Europe/Budapest").getTime();

// ── Tick ──────────────────────────────────────────────────────────────────────
async function tick() {
  const now     = new Date();
  const horizon = new Date(now.getTime() + LOOKAHEAD_MS);

  // Periodikus cleanup: régi dispatched kulcsok törlése
  // (a kulcs tartalmaz dátumot, tehát a mai napnál régebbiek már nem relevánsak)
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

// ── Tenant bell ütemezés ──────────────────────────────────────────────────────
async function scheduleTenantBells(tenantId: string, now: Date, horizon: Date) {
  const todayMidnight = todayInBudapest();

  const calDay = await (prisma as any).bellCalendarDay.findUnique({
    where:   { tenantId_date: { tenantId, date: todayMidnight } },
    include: { template: { include: { bells: { orderBy: [{ hour: "asc" }, { minute: "asc" }] } } } },
  }).catch(() => null);

  if (calDay?.isHoliday) return;

  // Hétvége ellenőrzés Budapest időzónában
  const budapestDayOfWeek = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Budapest",
    weekday: "short",
  }).format(now);
  const isWeekend = budapestDayOfWeek === "Sat" || budapestDayOfWeek === "Sun";
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

    // ── Kritikus guard: csak jövőbeli belleket ütemezünk ────────────────────
    // MIN_FUTURE_MS = 1000ms → ha a bell már elmúlt (vagy <1s múlva van),
    // nem ütemezzük. Ez véd a backend restart utáni "azonnali" csengetés ellen.
    if (waitMs < MIN_FUTURE_MS) continue;

    // Lookahead ablakon túl van → következő tick majd felveszi
    if (bellMs > horizon.getTime()) continue;

    // Nap-szintű dispatch key: "tenantId:2026-04-21:08:00:BELL"
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

    const bellTimeStr = `${String(bell.hour).padStart(2,"0")}:${String(bell.minute).padStart(2,"0")}`;
    console.log(`[BELLS-SCHEDULER] Ütemezve: ${bellTimeStr} | wait=${Math.round(waitMs/1000)}s | dur=${durationMs}ms | key=${dispatchKey}`);

    const timeouts: ReturnType<typeof setTimeout>[] = [];

    // ── PREPARE küldése (4s-sel korábban) ───────────────────────────────────
    const prepareTimeout = setTimeout(async () => {
      try {
        const allDevices = await prisma.device.findMany({
          where:  { tenantId },
          select: { id: true },
        });
        if (allDevices.length === 0) return;

        const snapOnline = await SnapcastService.isSnapserverOnline(tenantId);
        const onlineIds  = allDevices.map(d => d.id).filter(id => SyncEngine.isDeviceOnline(id));
        const offlineIds = allDevices.map(d => d.id).filter(id => !SyncEngine.isDeviceOnline(id));

        if (onlineIds.length > 0) {
          await SyncEngine.dispatchSync({
            tenantId,
            commandId,
            action:         "BELL",
            url:            audioUrl,
            title:          `Csengetés ${bellTimeStr}`,
            targetDeviceIds: onlineIds,
            snapcastActive:  snapOnline,   // csak akkor true ha snap tényleg él
            playAtMs:        bellMs,
            durationMs:      durationMs ?? undefined,
          });
          console.log(`[BELLS-SCHEDULER] PREPARE → ${onlineIds.length} online eszköz | snap=${snapOnline}`);
        }

        // Offline eszközök: DB queue
        if (offlineIds.length > 0) {
          await prisma.deviceCommand.createMany({
            data: offlineIds.map(deviceId => ({
              tenantId, deviceId, messageId: null,
              status: "QUEUED" as const,
              payload: {
                action: "BELL", url: audioUrl,
                type: bell.type, soundFile: bell.soundFile,
                hour: bell.hour, minute: bell.minute,
              },
            })),
          });
          console.log(`[BELLS-SCHEDULER] DB queue → ${offlineIds.length} offline eszköz`);
        }
      } catch (e) {
        console.error(`[BELLS-SCHEDULER] PREPARE hiba (${bellTimeStr}):`, e);
      }
    }, prepareDelay);
    timeouts.push(prepareTimeout);

    // ── Snapcast lejátszás pontosan a csengetés pillanatában ─────────────────
    const snapTimeout = setTimeout(async () => {
      try {
        const snapOnline = await SnapcastService.isSnapserverOnline(tenantId);
        if (snapOnline) {
          await SnapcastService.play({
            type:     "BELL",
            source:   { type: "file", path: soundPath },
            tenantId,
            title:    `Csengetés ${bellTimeStr}`,
          });
          console.log(`[BELLS-SCHEDULER] 🔔 Snap PLAY: ${bellTimeStr} | tenant=${tenantId}`);
        } else {
          console.log(`[BELLS-SCHEDULER] ⚠️ Snap offline, ${bellTimeStr} bell kihagyva (kliensek offline módban csengnek)`);
        }
      } catch (e) {
        console.error(`[BELLS-SCHEDULER] Snap PLAY hiba (${bellTimeStr}):`, e);
      } finally {
        _pendingTimeouts.delete(dispatchKey);
      }
    }, snapDelay);
    timeouts.push(snapTimeout);

    _pendingTimeouts.set(dispatchKey, timeouts);
  }
}

// ── Pending bellек törlése (pl. STOP_PLAYBACK híváskor) ──────────────────────
export function cancelPendingBells() {
  for (const [key, timeouts] of _pendingTimeouts.entries()) {
    timeouts.forEach(t => clearTimeout(t));
    _pendingTimeouts.delete(key);
  }
  console.log("[BELLS-SCHEDULER] Pending bellек törölve");
}

// ── Indítás ───────────────────────────────────────────────────────────────────
export function startBellsScheduler() {
  if (_running) return;
  _running = true;
  console.log("[BELLS-SCHEDULER] Indult (tick: 30s, lookahead: 90s, min_future: 1s)");
  tick();
  setInterval(tick, TICK_INTERVAL_MS);
}
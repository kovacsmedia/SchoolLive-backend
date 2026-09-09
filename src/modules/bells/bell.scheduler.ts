// src/modules/bells/bells.scheduler.ts
//
// v3 változások:
//   • broadcastSyncBells(tenantId): azonnali SYNC_BELLS push minden online kliensnek
//     → bell template/schedule módosításkor azonnal értesíti a klienseket
//   • MIN_FUTURE_MS guard megmarad (restart védelem)
//   • getBellMs() timezone fix megmarad

import { prisma }          from "../../prisma/client";
import { env }             from "../../config/env";
import { SyncEngine }      from "../../sync/SyncEngine";
import { SnapcastService } from "../snapcast/snapcast.service";
import { execSync }        from "child_process";
import { randomUUID }      from "crypto";
import { todayInBudapest, getBellMs, isBudapestWeekend } from "../../utils/budapest-time";
import { isOwnedByThisNode } from "../cluster/tenant-ownership";
import { bellSoundDiskPath, bellSoundUrlPath } from "./bell-sound-paths";

const TICK_INTERVAL_MS = 30_000;
const LOOKAHEAD_MS     = 90_000;
const PREPARE_LEAD_MS  = 1_500;
const MIN_FUTURE_MS    = 1_000;

// A snapserver-be írt PCM byte fizikai megszólalási késleltetése +
// az aktív alacsonyabb prio audio fade-out + post-fade gap helye:
//   1000 ms fade-out (FADE_OUT_BYTES) +
//    200 ms POST_FADE_GAP_MS +
//   1000 ms PRE_SILENCE +
//   ~200 ms ffmpeg warmup +
//   1000 ms snapserver "[server] buffer" =
//   ~3400 ms (felfelé kerekítve 3200, hogy ne legyen TOO LATE bell).
//
// Ezzel a bell ffmpeg-start a bellMs - 1000ms-en történik, és a snapserver-
// puffer után pontosan a bellMs-en hallhatóvá válik a chime.
const SNAP_PIPE_LEAD_MS = 3_200;

let _running = false;
let _startedAtMs = Date.now();
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
    // Multi-node: CSAK a saját node-hoz rendelt, AKTÍV tenantokat dolgozzuk fel.
    //
    // Enélkül minden node lefuttatta minden tenant csengetését. A snap-oldalt
    // ugyan megfogta a SnapcastService ownership-kapuja, DE a lenti
    // `deviceCommand.createMany` offline-ágat nem: a nem-tulajdonos node-on
    // MINDEN eszköz offline-nak látszik (nincs hozzá WS-kapcsolat), így minden
    // csengetéskor minden eszközre duplikált QUEUED parancs keletkezett –
    // dupla/késleltetett csengetés a kliensen, és korlátlanul növő tábla.
    const tenants = await prisma.tenant.findMany({
      where:  { isActive: true },
      select: { id: true },
    });
    let owned = 0;
    for (const tenant of tenants) {
      if (!isOwnedByThisNode(tenant.id)) continue;
      owned++;
      await scheduleTenantBells(tenant.id, now, horizon);
    }

    // Diagnosztika: ha VAN aktív tenant, de egyet sem birtokolunk, az vagy egy
    // teljesen üres (staging/DRAINING) node, vagy a cluster-lánc (heartbeat →
    // leader → rebalancer → ownership poller) akadt el. Utóbbi esetben néma
    // maradna minden csengetés, ezért ezt KI KELL írni – a hangot amúgy is
    // ugyanez az ownership-kapu védi (SnapcastService.getEngine), tehát ez a
    // log nem új függőséget jelez, hanem láthatóvá teszi a meglévőt.
    // Induláskor még nincs kiosztás: a heartbeat → leader-election →
    // rebalancer → ownership-poller lánc ~20 mp alatt áll fel. Az első
    // percben ezért NEM figyelmeztetünk, különben minden deploy után hamis
    // riasztás menne a logba. A 90 mp-es lookahead miatt eközben egyetlen
    // csengetés sem esik ki.
    if (tenants.length > 0 && owned === 0 && Date.now() - _startedAtMs > 60_000) {
      console.warn(
        `[BELLS-SCHEDULER] ⚠️ ${tenants.length} aktív tenant, de egyik sincs ehhez a node-hoz rendelve ` +
        `(${env.NODE_HOSTNAME}) – ellenőrizd a cluster-állapotot: GET /admin/cluster/status`
      );
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

  const isWeekend           = isBudapestWeekend(now);
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

    // A hangfájl helyét a bell-sound-paths feloldója adja: elsődlegesen a
    // tenant saját `audio/bells/<tenantId>/` könyvtára, visszaesésként a régi,
    // lapos elrendezés (ld. ott a részletes kommentet). Enélkül két iskola
    // azonos nevű hangja ugyanarra a fájlra mutatna.
    //
    // "A CSENGETÉS SOSEM MARADHAT EL": a feloldó a tenant fájlja → régi lapos
    // hely → default hang sorrendben keres, tehát egy hiányzó vagy törölt
    // feltöltés legrosszabb esetben MÁS hangot ad, csendet SOSEM.
    const resolved = bellSoundDiskPath(tenantId, bell.soundFile, bell.type);
    if (resolved?.isFallback) {
      console.warn(
        `[BELLS-SCHEDULER] ⚠️ Hiányzó hangfájl: ${bell.soundFile} ` +
        `(tenant=${tenantId}, ${String(bell.hour).padStart(2,"0")}:${String(bell.minute).padStart(2,"0")}) ` +
        `– DEFAULT hanggal csengetünk: ${resolved.path}`
      );
    } else if (!resolved) {
      // Ide csak sérült telepítésnél juthatunk (még a repóval szállított
      // default sincs meg). A snap-lejátszás kimarad, de a WS-parancs
      // MEGY: a kliensek a saját, firmware-be épített default hangjukból
      // lejátsszák. Ez az utolsó védvonal.
      console.error(
        `[BELLS-SCHEDULER] ⛔ Egyetlen hangfájl sem oldható fel (${bell.soundFile}, tenant=${tenantId}) – ` +
        `ellenőrizd az assets/bells/ meglétét a szerveren! A kliensek helyi másolatból játszanak.`
      );
    }
    const soundPath = resolved?.path ?? null;

    _dispatched.add(dispatchKey);

    const prepareDelay = Math.max(0, waitMs - PREPARE_LEAD_MS);
    // SNAP_PIPE_LEAD_MS-szel előbb indítunk a mixer-be, hogy a PRE_SILENCE +
    // ffmpeg warmup + snapserver buffer késleltetés után pontosan a bellMs-en
    // szólaljon meg a chime – szinkron a kliens HUD/unmute idővel.
    const snapDelay    = Math.max(0, waitMs - SNAP_PIPE_LEAD_MS);
    const commandId    = randomUUID();
    // A letöltési URL-nek ANNAK a node-nak kell mutatnia, ahol az eszköz
    // ténylegesen van – korábban ez fixen "api.schoollive.hu" volt, BASE_URL
    // fallback nélkül is (szemben a messages/radio/firmware modulokkal), így
    // egy második node-on lévő iskola eszközei az első node-ról töltöttek
    // volna – pont annak a kiesését hivatott kezelni a multi-node felállás.
    const audioUrl     = `${process.env.BASE_URL ?? `https://${env.NODE_HOSTNAME}`}${bellSoundUrlPath(tenantId, bell.soundFile)}`;
    const durationMs   = soundPath ? getAudioDurationMs(soundPath) : null;
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
        if (!snapOnline) return;
        // Nincs helyi fájl → nincs mit a mixerbe adni (a WS-értesítés már
        // kiment, a kliensek a saját másolatukból játszanak).
        if (!soundPath) return;

        // Csengetés MINDIG minden snap-csatlakozott klienshez megy → NEM adunk
        // explicit `deviceIdsToUnmute`-ot. Az `applyTargetingToClients` ekkor
        // az `if (wanted.size === 0)` ágon az ÖSSZES snap-szerverhez csatlakozott
        // klienst (rpcListClients) a saját user-volume-jukon unmute-olja –
        // függetlenül attól, hogy a kliens snap-client-id-je egyezik-e a
        // DB.Device.id-vel.
        await SnapcastService.play({
          type:    "BELL",
          source:  { type: "file", path: soundPath },
          tenantId,
          title:   `Csengetés ${bellTimeStr}`,
          // deviceIdsToUnmute: undefined → minden snap-csatlakozott kliens
        });
        console.log(`[BELLS-SCHEDULER] 🔔 Snap PLAY: ${bellTimeStr} (minden csatlakozott kliens)`);
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
  _startedAtMs = Date.now();
  console.log("[BELLS-SCHEDULER] Indult (tick: 30s, lookahead: 90s, min_future: 1s)");
  tick();
  setInterval(tick, TICK_INTERVAL_MS);
}
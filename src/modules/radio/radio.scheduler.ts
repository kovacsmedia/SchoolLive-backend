// src/modules/radio/radio.scheduler.ts
//
// Javítások:
//   • dispatchSchedule() pontosan a scheduledAt pillanatában indítja a Snapcastot
//     (setTimeout alapú, nem azonnal)
//   • Stale check: ha a scheduledAt > STALE_THRESHOLD_MS múltban van → skip
//   • SyncEngine dispatch is setTimeout-tal időzítve

import { prisma }          from "../../prisma/client";
import { SyncEngine }      from "../../sync/SyncEngine";
import { SnapcastService } from "../snapcast/snapcast.service";
import { isOwnedByThisNode } from "../cluster/tenant-ownership";

const TICK_INTERVAL_MS   = 10_000;   // 10s tick (pontosabb időzítéshez)
const LOOKAHEAD_MS       = 15_000;   // 15s előre néz (elég a felkészüléshez)
const STALE_THRESHOLD_MS = 5_000;    // ha > 5s múltban van → már nem játsszuk

let _running = false;
// Aktív timeouток nyilvántartása – stop esetén törölhetők
const _pendingTimeouts = new Map<string, ReturnType<typeof setTimeout>[]>();

async function tick() {
  const now     = new Date();
  const horizon = new Date(now.getTime() + LOOKAHEAD_MS);

  try {
    const due = await prisma.radioSchedule.findMany({
      where: {
        status:      "PENDING",
        // Csak a jövőbeli és közeli ütemezések (nem a múltbeliek)
        scheduledAt: {
          gte: new Date(now.getTime() - STALE_THRESHOLD_MS),
          lte: horizon,
        },
      },
      // A radioFile internetrádió-ütemezésnél NULL – ott a streamUrl/streamTitle
      // oszlop adja a forrást (a select nélkül is jön, skaláris mező).
      include: {
        radioFile: {
          select: { id: true, fileUrl: true, durationSec: true, originalName: true },
        },
      },
    });

    if (due.length === 0) return;
    console.log(`[RADIO-SCHEDULER] ${due.length} schedule(s) due`);

    for (const schedule of due) {
      // Már folyamatban van? (előző tick már beütemezte)
      if (_pendingTimeouts.has(schedule.id)) continue;

      // Multi-node: csak a saját node-hoz rendelt tenantok ütemezéseit
      // dolgozzuk fel. Enélkül MINDEN node lefuttatta ezt: a snap-lejátszást
      // ugyan megfogta a SnapcastService ownership-kapuja, de a lenti
      // offline-ág `deviceCommand.createMany`-je nem (a nem-tulajdonos
      // node-on minden eszköz offline-nak látszik) – duplikált QUEUED
      // parancsok minden eszközre –, és a `status: DISPATCHED` írásán is
      // versenyeztek a node-ok.
      if (!isOwnedByThisNode(schedule.tenantId)) continue;

      try {
        await scheduleDispatch(schedule);
      } catch (e) {
        console.error(`[RADIO-SCHEDULER] Failed to schedule ${schedule.id}:`, e);
      }
    }
  } catch (e) {
    console.error("[RADIO-SCHEDULER] tick error:", e);
  }
}

async function scheduleDispatch(schedule: {
  id:          string;
  tenantId:    string;
  targetType:  string;
  targetId:    string | null;
  scheduledAt: Date;
  endsAt:      Date | null;
  streamUrl:   string | null;
  streamTitle: string | null;
  radioFile:   { id: string; fileUrl: string; durationSec: number | null; originalName: string } | null;
}) {
  /*
   * KÉTFÉLE FORRÁS, EGY ÚTVONAL.
   *
   * Fájl-ütemezés: letöltött mp3, ismert hosszal, a mixer `url` forrásként
   * húzza, és magától véget ér (`persistent: false`).
   *
   * Internetrádió: élő stream, hossz nélkül. A mixernek `stream` forrásként
   * kell indítani, és `persistent: true`-val, különben az első pufferszünetet
   * a lejátszás végének venné és lekeverne. Pontosan ugyanaz a kombináció,
   * amit a `/radio/play-stream` (azonnali indítás) használ – az ütemezett út
   * nem térhet el tőle, különben más hangzana ütemezve, mint kézzel indítva.
   */
  const isStream    = !schedule.radioFile;
  const sourceUrl   = schedule.radioFile?.fileUrl     ?? schedule.streamUrl  ?? "";
  const sourceTitle = schedule.radioFile?.originalName ?? schedule.streamTitle ?? "Internetrádió";
  const sourceDur   = schedule.radioFile?.durationSec ?? null;

  if (!sourceUrl) {
    console.error(`[RADIO-SCHEDULER] ${schedule.id}: nincs forrás (se fájl, se stream) → skip`);
    await prisma.radioSchedule.updateMany({
      where: { id: schedule.id, status: "PENDING" },
      data:  { status: "DISPATCHED", dispatchedAt: new Date() },
    });
    return;
  }

  const now         = Date.now();
  const scheduledMs = schedule.scheduledAt.getTime();
  const waitMs      = scheduledMs - now;

  // Stale check: ha már elmúlt STALE_THRESHOLD_MS-nél régebben → skip
  if (waitMs < -STALE_THRESHOLD_MS) {
    console.warn(`[RADIO-SCHEDULER] Stale schedule ${schedule.id} (${-waitMs}ms régen) → skip`);
    await prisma.radioSchedule.update({
      where: { id: schedule.id },
      data:  { status: "DISPATCHED", dispatchedAt: new Date() },
    });
    return;
  }

  // Pontosan scheduledAt-kor indul a lejátszás
  // A SyncEngine PREPARE-t kell küldeni PREPARE_LEAD_MS-sel korábban
  const PREPARE_LEAD_MS = 4000;  // ennyi időt kapnak a kliensek a prefetchre
  const snapStartDelay  = Math.max(0, waitMs);
  const prepareDelay    = Math.max(0, waitMs - PREPARE_LEAD_MS);

  console.log(`[RADIO-SCHEDULER] Schedule ${schedule.id}: waitMs=${waitMs}, snapDelay=${snapStartDelay}, prepareDelay=${prepareDelay}`);

  const timeouts: ReturnType<typeof setTimeout>[] = [];

  // ── PREPARE küldése PREPARE_LEAD_MS-sel korábban ──────────────────────────
  const prepareTimeout = setTimeout(async () => {
    const allDeviceIds = await resolveDeviceIds(
      schedule.tenantId,
      schedule.targetType,
      schedule.targetId,
    );

    if (allDeviceIds.length === 0) {
      console.warn(`[RADIO-SCHEDULER] Nincs eszköz: ${schedule.id}`);
      return;
    }

    const commandId = `radio-${schedule.id}`;
    const snapOnline = await SnapcastService.isSnapserverOnline(schedule.tenantId);
    const onlineIds  = allDeviceIds.filter(id => SyncEngine.isDeviceOnline(id));
    const offlineIds = allDeviceIds.filter(id => !SyncEngine.isDeviceOnline(id));

    // SyncEngine PREPARE küldése
    if (onlineIds.length > 0) {
      await SyncEngine.dispatchSync({
        tenantId:        schedule.tenantId,
        commandId,
        action:          "PLAY_URL",
        kind:            "RADIO",
        url:             sourceUrl,
        title:           sourceTitle,
        targetDeviceIds: onlineIds,
        snapcastActive:  snapOnline,
        playAtMs:        scheduledMs,
        // durationMs: rádióhoz nincs fix hossz (STOP parancsig él)
        durationMs:      undefined,
      });
      console.log(`[RADIO-SCHEDULER] 📤 PREPARE → ${onlineIds.length} eszköz, playAt=${schedule.scheduledAt.toISOString()}`);
    }

    // DB queue – offline eszközök
    if (offlineIds.length > 0) {
      await prisma.deviceCommand.createMany({
        data: offlineIds.map(deviceId => ({
          tenantId:  schedule.tenantId,
          deviceId,
          messageId: null,
          status:    "QUEUED" as const,
          payload: {
            action:      "PLAY_URL",
            url:         sourceUrl,
            durationSec: sourceDur,
            radioFileId: schedule.radioFile?.id ?? null,
            title:       sourceTitle,
            scheduledAt: schedule.scheduledAt.toISOString(),
            source:      "RADIO",
          },
        })),
      });
    }
  }, prepareDelay);
  timeouts.push(prepareTimeout);

  // ── Snapcast stream indítása pontosan scheduledAt-kor ─────────────────────
  const snapTimeout = setTimeout(async () => {
    const snapOnline = await SnapcastService.isSnapserverOnline(schedule.tenantId);
    if (snapOnline) {
      // A célzott eszközöket unmutáljuk; a többi marad néma.
      const targetIds = await resolveDeviceIds(schedule.tenantId, schedule.targetType, schedule.targetId);
      await SnapcastService.play({
        type:               "RADIO",
        source:             isStream
          ? { type: "stream", url: sourceUrl }
          : { type: "url",    url: sourceUrl },
        tenantId:           schedule.tenantId,
        title:              sourceTitle,
        deviceIdsToUnmute:  targetIds,
        persistent:         isStream,
      });
      console.log(`[RADIO-SCHEDULER] 📻 Snapcast START: "${sourceTitle}"${isStream ? " (stream)" : ""} @ ${new Date().toISOString()}`);
    } else {
      console.warn(`[RADIO-SCHEDULER] ⚠️ Snapserver offline: ${schedule.tenantId}`);
    }

    // Státusz frissítés – feltételes (csak PENDING-ről), hogy egy esetleges
    // dupla belépés (pl. ownership-váltás közben) ne írja felül egy másik
    // node már lezárt dispatchét.
    await prisma.radioSchedule.updateMany({
      where: { id: schedule.id, status: "PENDING" },
      data:  { status: "DISPATCHED", dispatchedAt: new Date() },
    });

    // Timeout cleanup
    _pendingTimeouts.delete(schedule.id);

  }, snapStartDelay);
  timeouts.push(snapTimeout);

  /*
   * LEJÁTSZÁS VÉGE.
   *
   * Ha a felhasználó megadott végidőpontot, ott lekeverünk és leállítunk.
   * Rövidebb hangnál ennek nincs hatása: addigra a forrás magától véget ér,
   * a mixer pedig üresjáratba kerül – a leállítás ilyenkor no-op.
   *
   * SZÁNDÉKOSAN a mixer `stopRadio`-ját hívjuk (nem a `stopRadioImmediate`-et):
   * az utóbbi MINDEN függő ütemezést is törölne, tehát egy későbbi, másik
   * lejátszást is elvinne. Itt csak ezt az egyet zárjuk le.
   */
  if (schedule.endsAt) {
    const endDelay = schedule.endsAt.getTime() - Date.now();
    if (endDelay > 0) {
      const endTimeout = setTimeout(async () => {
        try {
          await SnapcastService.stopRadio(schedule.tenantId);
          SyncEngine.broadcastImmediate(schedule.tenantId, { action: "STOP_PLAYBACK" });
          console.log(
            `[RADIO-SCHEDULER] ⏹ Lejátszás vége (beállított időpont): ` +
            `"${sourceTitle}" @ ${new Date().toISOString()}`
          );
        } catch (e) {
          console.error(`[RADIO-SCHEDULER] Leállítás hiba (${schedule.id}):`, e);
        }
      }, endDelay);
      timeouts.push(endTimeout);
    } else {
      console.warn(
        `[RADIO-SCHEDULER] ${schedule.id}: a megadott vége-időpont már elmúlt – kihagyva`
      );
    }
  }

  _pendingTimeouts.set(schedule.id, timeouts);
}

// ── Rádió azonnali leállítása (stop gomb) ─────────────────────────────────────
export async function stopRadioImmediate(tenantId: string): Promise<void> {
  // 1. Függő timeoutok törlése (ne induljon el a tervezett lejátszás)
  for (const [scheduleId, timeouts] of _pendingTimeouts.entries()) {
    timeouts.forEach(t => clearTimeout(t));
    _pendingTimeouts.delete(scheduleId);
    console.log(`[RADIO-SCHEDULER] Pending timeout törölve: ${scheduleId}`);
  }

  // 2. Snapcast leállítása
  await SnapcastService.stopRadio(tenantId);

  // 3. SyncEngine broadcast: STOP_PLAYBACK minden online eszközre
  SyncEngine.broadcastImmediate(tenantId, {
    action: "STOP_PLAYBACK",
  });

  console.log(`[RADIO-SCHEDULER] ⏹ Rádió leállítva: tenant=${tenantId}`);
}

async function resolveDeviceIds(tenantId: string, targetType: string, targetId: string | null): Promise<string[]> {
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

// ── yt-dlp napi frissítés ─────────────────────────────────────────────────────
async function updateYtDlp() {
  const { spawn } = await import("child_process");
  const { existsSync } = await import("fs");
  const candidates = [
    "/home/deploy/.local/bin/yt-dlp",
    "/home/balazs/.local/bin/yt-dlp",
    "/usr/local/bin/yt-dlp",
    "/usr/bin/yt-dlp",
  ];
  const bin = candidates.find(p => existsSync(p)) ?? "yt-dlp";
  console.log(`[YT-UPDATE] yt-dlp frissítés: ${bin}`);
  return new Promise<void>((resolve) => {
    const proc = spawn(bin, ["--update"], { stdio: "pipe" });
    let out = "";
    proc.stdout?.on("data", (d: Buffer) => { out += d.toString(); });
    proc.stderr?.on("data", (d: Buffer) => { out += d.toString(); });
    proc.on("close", (code: number) => {
      console.log(`[YT-UPDATE] Kész (code=${code}): ${out.trim().split("\n").pop() ?? ""}`);
      resolve();
    });
    proc.on("error", (e: Error) => { console.warn("[YT-UPDATE] Hiba:", e.message); resolve(); });
  });
}

function scheduleYtDlpUpdate() {
  function msUntilNextUpdate(): number {
    const now  = new Date();
    const next = new Date(now);
    next.setHours(3, 0, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    return next.getTime() - now.getTime();
  }
  setTimeout(function run() {
    void updateYtDlp();
    setTimeout(run, 24 * 60 * 60 * 1000);
  }, msUntilNextUpdate());
}

export function startRadioScheduler() {
  if (_running) return;
  _running = true;
  console.log("[RADIO-SCHEDULER] Started (tick every 10s, lookahead 15s)");
  tick();
  setInterval(tick, TICK_INTERVAL_MS);
  scheduleYtDlpUpdate();
}
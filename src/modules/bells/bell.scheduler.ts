// src/modules/bells/bells.scheduler.ts
//
// Percenként fut, megkeresi az aktuális csengetési bejegyzéseket
// és DeviceCommand-okat küld a virtuális eszközöknek (authType: JWT).
// Az ESP32 eszközök a /bells/sync alapján saját maguk csengetnek,
// ezért a scheduler csak a VP (VirtualPlayer) eszközöket célozza.
//
// Integrálás server.ts-ben:
//   import { startBellsScheduler } from "./modules/bells/bells.scheduler";
//   startBellsScheduler();

import { prisma } from "../../prisma/client";

const TICK_INTERVAL_MS  = 60_000;  // percenként ellenőrzés
const DISPATCH_WINDOW_S = 30;      // ±30 másodperces ablak

let _running = false;
// Egy munkamenetben már elküldött csengetések nyilvántartása (memória cache)
const _dispatched = new Set<string>();

async function tick() {
  const now     = new Date();
  const todayMidnight = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));

  const hour   = now.getHours();
  const minute = now.getMinutes();
  const sec    = now.getSeconds();

  // Csak ha az időpercen belüli ablakban vagyunk (0–30s)
  if (sec > DISPATCH_WINDOW_S) return;

  try {
    // Tenant-enként dolgozzuk fel
    const tenants = await prisma.tenant.findMany({ select: { id: true } });

    for (const tenant of tenants) {
      await processTenant(tenant.id, todayMidnight, hour, minute, now);
    }
  } catch (e) {
    console.error("[BELLS-SCHEDULER] tick error:", e);
  }
}

async function processTenant(
  tenantId: string,
  todayMidnight: Date,
  hour: number,
  minute: number,
  now: Date
) {
  // VP eszközök lekérése (authType: JWT = virtuális player)
  const vpDevices = await prisma.device.findMany({
    where:  { tenantId, authType: "JWT" },
    select: { id: true },
  });

  if (vpDevices.length === 0) return;

  // Mai napi csengetési rend meghatározása
  const calDay = await (prisma as any).bellCalendarDay.findUnique({
    where: { tenantId_date: { tenantId, date: todayMidnight } },
    include: {
      template: {
        include: { bells: { orderBy: [{ hour: "asc" }, { minute: "asc" }] } },
      },
    },
  }).catch(() => null);

  // Szünnap → nem csengetünk
  if (calDay?.isHoliday) return;

  let bells: Array<{ hour: number; minute: number; type: string; soundFile: string }> = [];

  if (calDay?.template?.bells?.length) {
    bells = calDay.template.bells;
  } else {
    // Default sablon
    const defaultTemplate = await (prisma as any).bellScheduleTemplate.findFirst({
      where:   { tenantId, isDefault: true },
      include: { bells: { orderBy: [{ hour: "asc" }, { minute: "asc" }] } },
    }).catch(() => null);
    bells = defaultTemplate?.bells ?? [];
  }

  if (bells.length === 0) return;

  // Keresés: van-e most lejátszandó csengetés?
  const dueBells = bells.filter(
    (b) => b.hour === hour && b.minute === minute
  );

  if (dueBells.length === 0) return;

  for (const bell of dueBells) {
    const dispatchKey = `${tenantId}:${now.toISOString().slice(0, 16)}:${bell.hour}:${bell.minute}:${bell.type}`;

    if (_dispatched.has(dispatchKey)) continue;
    _dispatched.add(dispatchKey);

    // Cache takarítás: 1000 elem felett töröljük a régiek felét
    if (_dispatched.size > 1000) {
      const arr = Array.from(_dispatched);
      arr.slice(0, 500).forEach((k) => _dispatched.delete(k));
    }

    const audioUrl = `/audio/bells/${bell.soundFile}`;

    await prisma.deviceCommand.createMany({
      data: vpDevices.map((dev) => ({
        tenantId,
        deviceId:  dev.id,
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
      `[BELLS-SCHEDULER] Dispatched bell ${bell.hour}:${String(bell.minute).padStart(2,"0")}` +
      ` (${bell.type}) → ${vpDevices.length} VP device(s) | tenant: ${tenantId}`
    );
  }
}

export function startBellsScheduler() {
  if (_running) return;
  _running = true;
  console.log("[BELLS-SCHEDULER] Started (tick every 60s, ±30s window)");
  tick();
  setInterval(tick, TICK_INTERVAL_MS);
}
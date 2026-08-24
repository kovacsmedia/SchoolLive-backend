// src/modules/devices/device.lifecycle.ts
//
// Eszköz lifecycle scheduler: rendszeres takarítás a Device, DeviceProvisionSession
// és PendingDevice táblákon, plus a snapserver kliens listáján.
//
// Szabályok:
//   1. Online → offline transition
//      Ha egy Device legutóbbi lastSeenAt (beacon/poll) > 10 perce,
//      online: false-ra állítjuk.
//
//   2. Stale provisioning takarítás (1 óra)
//      - DeviceProvisionSession-ök, amelyek 1 óránál régebbiek, törölve.
//      - PendingDevice rekordok, amelyek 1 óránál régebben jeleztek vissza, törölve.
//      - Olyan Device-ok, amelyek lastSeenAt = NULL (sosem beaconoltak) és
//        createdAt > 1 órája, törölve (megrekedt provisioning aktiválás miatt).
//
// Megjegyzés: korábban volt egy 4. szabály is (hard delete 48 óra offline
// után), amit eltávolítottunk. Az eredeti indoka az volt, hogy egy tartósan
// offline, de célzott eszköz a snap-lejátszás indítása előtt kivárta a teljes
// readiness-timeoutot (ld. snapcast.service.ts prepareClientsForPlayback) –
// ezt most a gyökerénél javítottuk (csak a ténylegesen online eszközökre
// várunk), így nincs szükség az eszközök automatikus törlésére hosszas
// offline állapot esetén (pl. nyári szünet alatt egy iskola összes eszköze
// hetekig offline lehet – ezeket nem szabad elveszíteni).

import { prisma } from "../../prisma/client";

const TICK_INTERVAL_MS = 60_000; // 1 perc

const OFFLINE_AFTER_MS       = 10 * 60 * 1000;       // 10 perc
const PROVISIONING_STALE_MS  = 60 * 60 * 1000;       // 1 óra

let _running = false;

async function markStaleDevicesOffline(): Promise<number> {
  const threshold = new Date(Date.now() - OFFLINE_AFTER_MS);

  const r = await prisma.device.updateMany({
    where: {
      online: true,
      lastSeenAt: { lt: threshold },
    },
    data: { online: false },
  });

  if (r.count > 0) {
    console.log(`[DEVICE-LIFECYCLE] ${r.count} eszköz offline-ra állítva (>10 perc beacon nélkül)`);
  }
  return r.count;
}

async function purgeStaleProvisioning(): Promise<number> {
  const threshold = new Date(Date.now() - PROVISIONING_STALE_MS);

  let total = 0;

  // a) DeviceProvisionSession - lejárt / 1 óránál régebbi sessionök
  const sessions = await prisma.deviceProvisionSession.deleteMany({
    where: { createdAt: { lt: threshold } },
  });
  total += sessions.count;
  if (sessions.count > 0) {
    console.log(`[DEVICE-LIFECYCLE] ${sessions.count} DeviceProvisionSession törölve (>1 órás)`);
  }

  // b) PendingDevice - 1 órája utolsóra jelzett
  const pending = await prisma.pendingDevice.deleteMany({
    where: { lastSeenAt: { lt: threshold } },
  });
  total += pending.count;
  if (pending.count > 0) {
    console.log(`[DEVICE-LIFECYCLE] ${pending.count} PendingDevice törölve (>1 órás)`);
  }

  // c) Olyan Device, ami sosem beaconolt, és 1 órája lett létrehozva
  // (megrekedt provisioning - a frontend ne mutassa "valaha várt" eszközként)
  const orphanDevices = await prisma.device.findMany({
    where: {
      lastSeenAt: null,
      createdAt: { lt: threshold },
    },
    select: { id: true, tenantId: true, name: true },
  });

  if (orphanDevices.length > 0) {
    await prisma.device.deleteMany({
      where: { id: { in: orphanDevices.map((d) => d.id) } },
    });
    total += orphanDevices.length;
    console.log(
      `[DEVICE-LIFECYCLE] ${orphanDevices.length} orphan Device törölve (sosem beaconolt, >1 órás): ${orphanDevices.map((d) => d.name).join(", ")}`
    );
  }

  return total;
}

async function tick(): Promise<void> {
  try {
    await markStaleDevicesOffline();
    await purgeStaleProvisioning();
  } catch (e) {
    console.error("[DEVICE-LIFECYCLE] tick hiba:", e);
  }
}

export function startDeviceLifecycleScheduler(): void {
  if (_running) return;
  _running = true;
  console.log("[DEVICE-LIFECYCLE] Indult (tick: 60s, offline=10p, provisioning_stale=1h)");

  // Első tick rögtön, hogy a backend restart után takarodjon, mielőtt a kliens
  // forgalom elindul.
  void tick();

  setInterval(() => void tick(), TICK_INTERVAL_MS);
}

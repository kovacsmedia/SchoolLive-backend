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
//   3. Hard delete 48 óra offline után
//      - Olyan Device-ok, akik valaha beaconoltak (lastSeenAt != NULL) de már
//        > 48 órája, törölve a DB-ből.
//      - Mindegyik device.id-ra Server.DeleteClient hívás a saját tenant snapserver-én,
//        hogy a snapcast `Server.GetStatus` válaszában se maradjon zombi entry.
//        Ezzel a `applyTargetingToClients` nem küld feleslegesen HTTP RPC-t
//        többé nem létező klienseknek.

import { prisma } from "../../prisma/client";
import { rpcDeleteClient } from "../snapcast/snapcast-rpc";

const TICK_INTERVAL_MS = 60_000; // 1 perc

const OFFLINE_AFTER_MS       = 10 * 60 * 1000;       // 10 perc
const PROVISIONING_STALE_MS  = 60 * 60 * 1000;       // 1 óra
const HARD_DELETE_AFTER_MS   = 48 * 60 * 60 * 1000;  // 48 óra

let _running = false;

function snapHttpPortForSnapPort(snapPort: number): number {
  return snapPort + 1000;
}

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

async function purgeOldOfflineDevices(): Promise<number> {
  const threshold = new Date(Date.now() - HARD_DELETE_AFTER_MS);

  // Csak azok, akik valaha beaconoltak (lastSeenAt != NULL), és > 48 órája.
  // Akik sosem beaconoltak, azokat a purgeStaleProvisioning() takarítja 1 óra után.
  const stale = await prisma.device.findMany({
    where: {
      lastSeenAt: { lt: threshold, not: null },
    },
    select: { id: true, tenantId: true, name: true },
  });

  if (stale.length === 0) return 0;

  // Snap szerver kliens lista takarítás: az érintett tenantok snapPort-jait kérdezzük le.
  const tenantIds = [...new Set(stale.map((d) => d.tenantId))];
  const tenants = await prisma.tenant.findMany({
    where: { id: { in: tenantIds } },
    select: { id: true, snapPort: true },
  });
  const snapPortByTenant = new Map<string, number>();
  for (const t of tenants) {
    if (t.snapPort) snapPortByTenant.set(t.id, t.snapPort);
  }

  // Snapserveren is töröljük a klienseket (Server.DeleteClient).
  // Ezt szándékosan a DB-delete ELŐTT tesszük, hogy ha az RPC fail, a következő
  // tick újrapróbálkozik.
  for (const d of stale) {
    const snapPort = snapPortByTenant.get(d.tenantId);
    if (!snapPort) continue;

    const ok = await rpcDeleteClient(snapHttpPortForSnapPort(snapPort), d.id);
    if (!ok) {
      console.warn(`[DEVICE-LIFECYCLE] Server.DeleteClient failed for ${d.id} (snapPort=${snapPort})`);
    }
  }

  // DB delete
  await prisma.device.deleteMany({
    where: { id: { in: stale.map((d) => d.id) } },
  });

  console.log(
    `[DEVICE-LIFECYCLE] ${stale.length} régi offline Device törölve (>48 órás): ${stale.map((d) => d.name).join(", ")}`
  );

  return stale.length;
}

async function tick(): Promise<void> {
  try {
    await markStaleDevicesOffline();
    await purgeStaleProvisioning();
    await purgeOldOfflineDevices();
  } catch (e) {
    console.error("[DEVICE-LIFECYCLE] tick hiba:", e);
  }
}

export function startDeviceLifecycleScheduler(): void {
  if (_running) return;
  _running = true;
  console.log("[DEVICE-LIFECYCLE] Indult (tick: 60s, offline=10p, provisioning_stale=1h, hard_delete=48h)");

  // Első tick rögtön, hogy a backend restart után takarodjon, mielőtt a kliens
  // forgalom elindul.
  void tick();

  setInterval(() => void tick(), TICK_INTERVAL_MS);
}

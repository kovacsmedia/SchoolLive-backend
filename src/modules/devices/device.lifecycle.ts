// src/modules/devices/device.lifecycle.ts
//
// Eszköz lifecycle scheduler: rendszeres takarítás a Device, DeviceProvisionSession
// és PendingDevice táblákon, plus a snapserver kliens listáján.
//
// Szabályok:
//   1. Online → offline transition
//      Ha egy Device legutóbbi lastSeenAt (beacon/poll) > 10 perce,
//      online: false-ra állítjuk. Ez CSAK állapotjelző az admin felületen –
//      a webplayer munkamenetét NEM zárjuk le vele (a korábbi ilyen logika
//      kiléptette a termekben futó lejátszókat, ld. lentebb a részletes
//      magyarázatot).
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

  // ELTÁVOLÍTVA: a webplayer munkamenetének lezárása 10 perc offline után.
  //
  // Itt korábban a JWT-auth (webplayer) Device-okhoz tartozó UserSession
  // sorokat töröltük, ha a `lastSeenAt` 10 percnél régebbi volt. Ez a
  // gyakorlatban KILÉPTETTE a termekben futó webplayereket: elég volt egy 10
  // percnél hosszabb hálózati kimaradás vagy egy elhúzódó backend-leállás, és
  // a session eltűnt → a köv. kérés 401 `session_revoked` → a kliens a
  // bejelentkező képernyőre került, holott senki nem nyúlt hozzá.
  //
  // A követelmény egyértelmű: a webplayer sem magától, sem a backend miatt
  // NEM léphet ki. A UserSession tábla hizlalása ellen a lenti
  // `purgeStaleSessions()` (30 nap érintetlenség) véd, ami bőven a normál
  // használat fölött van, és nem büntet egy átmeneti kiesést.
  //
  // Az eszköz `online` flagjének kivezetése (lentebb) VÁLTOZATLAN – az csak
  // egy állapotjelző az admin felületen, nem érinti a hitelesítést.
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

// A UserSession tábla korábban SOSEM takarodott: a `logout()` csak a saját
// sorát törli, de egy egyszerűen bezárt böngésző (nincs sendBeacon, elszállt
// hálózat, összeomlott gép) sora örökre bennmaradt. Mostantól EZ az egyetlen
// automatikus takarítás – a webplayer 10 perces offline-alapú kiléptetése
// megszűnt (ld. fentebb). A tábla korlátlanul nőtt, és minden authJwt-hívás
// ezen keresztül keresett.
//
// A `JWT_ACCESS_TTL` 3650d óta a token maga nem jár le, ezért az elhagyott
// sorokat idő alapján kell kivezetni. 30 nap érintetlenség bőven a normál
// használat FÖLÖTT van (a frontend 5 percenként frissít, ami lastSeenAt-et is
// ír), tehát élő munkamenetet nem zárhat be.
const SESSION_STALE_MS = 30 * 24 * 60 * 60 * 1000;   // 30 nap

async function purgeStaleSessions(): Promise<number> {
  const threshold = new Date(Date.now() - SESSION_STALE_MS);
  const r = await prisma.userSession.deleteMany({
    where: { lastSeenAt: { lt: threshold } },
  });
  if (r.count > 0) {
    console.log(`[DEVICE-LIFECYCLE] ${r.count} elhagyott munkamenet törölve (>30 nap inaktív)`);
  }
  return r.count;
}

async function tick(): Promise<void> {
  try {
    await markStaleDevicesOffline();
    await purgeStaleProvisioning();
    await purgeStaleSessions();
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

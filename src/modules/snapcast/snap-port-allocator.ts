// src/modules/snapcast/snap-port-allocator.ts
//
// Tenant-szintű snapserver port-allokáció.
//
// A snapserver-t per-tenant futtatjuk PM2 alatt; minden tenanthoz egy egyedi
// stream-port (snapPort) és egy egyedi HTTP/RPC-port (snapPort + 1000) tartozik.
// Az új tenant-create flow ezt automatikusan kiosztja a 1800–1880 (alapérték)
// tartományban a legkisebb szabad portot kiválasztva.
//
// A tartomány env-változókkal felülírható (`SNAP_PORT_BASE`, `SNAP_PORT_MAX`),
// hogy környezetenként eltérő tűzfal-szabályokhoz lehessen igazítani; a
// `+1000` HTTP-port offszet a `snapcast.service.ts`-ben rögzítve van, tehát
// a tartománynak biztosítania kell, hogy `snapPort + 1000` is szabad legyen
// a host-on (alapértelmezetten 2800–2880).

import { prisma } from "../../prisma/client";

const SNAP_PORT_BASE = Number(process.env.SNAP_PORT_BASE ?? "1800");
const SNAP_PORT_MAX  = Number(process.env.SNAP_PORT_MAX  ?? "1880");

export const SNAP_PORT_RANGE = {
  base: SNAP_PORT_BASE,
  max:  SNAP_PORT_MAX,
  size: SNAP_PORT_MAX - SNAP_PORT_BASE + 1,
};

/**
 * Lefoglal egy szabad snapPort-ot a megengedett tartományból.
 *
 * Algoritmus: lekérdezzük az összes már lefoglalt port-ot, majd lineárisan
 * megkeressük a tartomány legkisebb szabad slot-ját. Ha a tartomány teli,
 * null-t adunk vissza – ekkor a hívó (POST /admin/tenants) 507-es hibát küld.
 *
 * Race-condition védelem: a `Tenant.snapPort` mező `@unique`, tehát ha két
 * konkurens create ugyanazt a portot választaná, Prisma `P2002` hibát ad,
 * és az újrapróbálkozást a hívó kezeli (loop max 5 retry).
 */
export async function allocateNextSnapPort(): Promise<number | null> {
  const used = new Set<number>(
    (await prisma.tenant.findMany({
      where:  { snapPort: { not: null } },
      select: { snapPort: true },
    }))
      .map(t => t.snapPort)
      .filter((p): p is number => typeof p === "number")
  );

  for (let p = SNAP_PORT_BASE; p <= SNAP_PORT_MAX; p++) {
    if (!used.has(p)) return p;
  }
  return null;
}
